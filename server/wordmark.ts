import type { IncomingMessage } from 'node:http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { requireMutation, type Session } from './auth'
import { config } from './config'
import { controlFailure, text } from './control-plane'
import { database } from './database/client'
import { body, HttpError } from './http'

/** The shared pro page owns generation and upload UI; pro retains AI authorization. */
export async function generateBrandWordmark(
  req: IncomingMessage,
  session: Session
): Promise<unknown> {
  requireMutation(req, session)
  for (const permission of [
    'System:WebsiteConfig:Publish',
    'System:WebsiteConfig:GenerateWordmark',
    'BffResource:Add'
  ]) {
    const result = await database.rpc('bff_actor_can', {
      p_actor: session.member.id,
      p_permission: permission
    })
    controlFailure(result.error)
    if (result.data !== true)
      throw new HttpError(403, '生成品牌字图需要 AI 艺术字生成、网站配置发布和资源上传权限')
  }
  const input = await body(req, 4096)
  const siteName = text(input.siteName, '系统名称', 60, true)
  let response: Response
  try {
    response = await fetch(new URL('/functions/v1/ai-website-wordmark', config.issuer), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.tokens.accessToken}`
      },
      body: JSON.stringify({ siteName }),
      signal: AbortSignal.timeout(180_000)
    })
  } catch (cause) {
    throw new HttpError(503, 'AI 品牌字图服务暂时不可用，请稍后重试', 'WORDMARK_UNAVAILABLE', {
      cause
    })
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new HttpError(403, '当前统一账号没有身份中心的 AI 品牌字图权限，请联系身份中心管理员')
    if (response.status === 429) throw new HttpError(429, 'AI 字图生成请求较多，请稍后重试')
    throw new HttpError(503, 'AI 品牌字图服务暂时不可用，请稍后重试')
  }
  const result: unknown = await response.json()
  if (
    !isObjectRecord(result) ||
    typeof result.imageBase64 !== 'string' ||
    !result.imageBase64 ||
    result.imageBase64.length > 24_000_000 ||
    typeof result.mimeType !== 'string' ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(result.mimeType) ||
    typeof result.runId !== 'string' ||
    !result.runId
  )
    throw new HttpError(503, 'AI 品牌字图服务返回了无效结果，请稍后重试')
  // Project only the public image DTO. Credentials and provider diagnostics never leave BFF.
  return {
    imageBase64: result.imageBase64,
    mimeType: result.mimeType,
    runId: result.runId,
    model: typeof result.model === 'string' ? result.model : '',
    generatedAt:
      typeof result.generatedAt === 'string' ? result.generatedAt : new Date().toISOString()
  }
}
