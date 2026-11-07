import type { IncomingMessage } from 'node:http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import {
  BFF_BRANDING_DEFAULTS,
  type BffBrandingConfig,
  type BffBrandingRecord
} from '../src/types/branding'
import { requireMutation, type Session } from './auth'
import { uuid } from './applications'
import { config } from './config'
import { controlFailure, text } from './control-plane'
import { database } from './database/client'
import { body, HttpError } from './http'

function imageUrl(value: unknown): string {
  const source = text(value, '图片地址', 2000)
  if (!source) return ''
  if (/[\\\s]/.test(source) || source.startsWith('//'))
    throw new HttpError(400, '图片地址需为 HTTPS 地址或本站相对路径')
  let target: URL
  try {
    target = new URL(source, config.origin)
  } catch {
    throw new HttpError(400, '图片地址格式无效')
  }
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (source.startsWith('/')
      ? target.origin !== config.origin || target.pathname !== source
      : target.protocol !== 'https:')
  )
    throw new HttpError(400, '图片地址需为不含账号、查询参数与片段的 HTTPS 地址或本站相对路径')
  return source.startsWith('/') ? target.pathname : target.href
}

export function brandingInput(value: unknown): BffBrandingConfig {
  if (
    !isObjectRecord(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(BFF_BRANDING_DEFAULTS, key))
  )
    throw new HttpError(400, '品牌配置包含不支持的配置项')
  const kind = value.watermarkContentType
  if (
    typeof value.watermarkEnabled !== 'boolean' ||
    (kind !== 'username' && kind !== 'username_time' && kind !== 'site_name' && kind !== 'custom')
  )
    throw new HttpError(400, '请选择有效的水印设置')
  const customText = text(value.watermarkCustomText, '自定义水印', 80)
  if (value.watermarkEnabled && kind === 'custom' && !customText)
    throw new HttpError(400, '请填写自定义水印内容')
  return {
    siteName: text(value.siteName, '系统名称', 60, true),
    siteShortName: text(value.siteShortName, '系统简称', 40),
    siteDescription: text(value.siteDescription, '系统说明', 255),
    logoUrl: imageUrl(value.logoUrl),
    faviconUrl: imageUrl(value.faviconUrl),
    watermarkEnabled: value.watermarkEnabled,
    watermarkContentType: kind,
    watermarkCustomText: customText
  }
}

export function brandingDto(value: unknown): BffBrandingRecord {
  if (
    !isObjectRecord(value) ||
    typeof value.id !== 'string' ||
    !Number.isSafeInteger(value.version) ||
    typeof value.version !== 'number' ||
    value.version < 0 ||
    !isObjectRecord(value.config) ||
    (value.createdAt !== null && typeof value.createdAt !== 'string') ||
    (value.updatedAt !== null && typeof value.updatedAt !== 'string') ||
    typeof value.updatedByName !== 'string'
  )
    throw new Error('Invalid branding configuration')
  return {
    id: uuid(value.id),
    version: value.version,
    config: brandingInput({ ...BFF_BRANDING_DEFAULTS, ...value.config }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    updatedByName: value.updatedByName
  }
}

export async function readBranding(session: Session): Promise<BffBrandingRecord> {
  const result = await database.rpc('bff_read_branding', { p_actor: session.member.id })
  controlFailure(result.error)
  return brandingDto(result.data)
}

export async function writeBranding(
  req: IncomingMessage,
  session: Session
): Promise<BffBrandingRecord> {
  requireMutation(req, session)
  const input = await body(req, 16384)
  if (
    typeof input.version !== 'number' ||
    !Number.isSafeInteger(input.version) ||
    input.version < 0
  )
    throw new HttpError(400, '配置版本缺失，请重新加载后再保存')
  const result = await database.rpc('bff_write_branding', {
    p_actor: session.member.id,
    p_version: input.version,
    p_config: brandingInput(input.config)
  })
  controlFailure(result.error)
  return brandingDto(result.data)
}
