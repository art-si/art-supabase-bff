import type { IncomingMessage } from 'node:http'
import {
  getAuthChannelValidationMessage,
  normalizeAuthChannels
} from 'art-supabase-pro/src/utils/supabase/auth-channels'
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
    throw new HttpError(400, '网站配置包含不支持的配置项')
  const merged = { ...BFF_BRANDING_DEFAULTS, ...value }
  const stringLimits: Record<string, number> = {
    siteName: 60,
    siteShortName: 40,
    siteDescription: 255,
    watermarkCustomText: 80,
    loginTitle: 80,
    loginSubtitle: 255,
    loginDescription: 255,
    turnstileSiteKey: 120,
    maintenanceMessage: 160,
    seoTitle: 80,
    seoKeywords: 160,
    seoDescription: 500,
    contactEmail: 254,
    contactPhone: 64,
    contactAddress: 500,
    copyrightText: 255,
    icpRecord: 160,
    policeRecord: 160
  }
  const normalized = { ...merged }
  for (const [key, max] of Object.entries(stringLimits)) {
    const raw = merged[key as keyof BffBrandingConfig]
    if (raw !== null && typeof raw !== 'string') throw new HttpError(400, `${key}需为文字内容`)
    Object.assign(normalized, {
      [key]: text(raw, key, max, key === 'siteName' || key === 'loginTitle')
    })
  }
  for (const key of ['logoUrl', 'faviconUrl', 'wordmarkLightUrl', 'wordmarkDarkUrl'] as const) {
    const raw = merged[key]
    if (raw !== null && typeof raw !== 'string') throw new HttpError(400, '图片地址格式无效')
    normalized[key] = imageUrl(raw)
  }
  for (const key of [
    'wordmarkImageEnabled',
    'watermarkEnabled',
    'captchaEnabled',
    'registerEnabled',
    'maintenanceEnabled',
    'enabled'
  ] as const) {
    if (typeof merged[key] !== 'boolean') throw new HttpError(400, `${key}开关格式无效`)
  }
  if (
    !['username', 'username_time', 'site_name', 'custom'].includes(merged.watermarkContentType) ||
    !['zh', 'en'].includes(merged.defaultLanguage) ||
    merged.captchaType !== 'turnstile' ||
    !['normal', 'compact', 'flexible', 'hidden'].includes(merged.turnstileSize || '') ||
    !['light', 'dark', 'auto'].includes(merged.turnstileTheme || '')
  )
    throw new HttpError(400, '请选择有效的网站语言、验证码或水印设置')
  if (
    !Number.isSafeInteger(merged.captchaMaxAttempts) ||
    merged.captchaMaxAttempts < 0 ||
    merged.captchaMaxAttempts > 20 ||
    !Number.isSafeInteger(merged.captchaLockMinutes) ||
    merged.captchaLockMinutes < 0 ||
    merged.captchaLockMinutes > 1440
  )
    throw new HttpError(400, '验证码次数或锁定时间无效')
  if (merged.wordmarkImageEnabled && (!normalized.wordmarkLightUrl || !normalized.wordmarkDarkUrl))
    throw new HttpError(400, '启用品牌字图后，请同时配置亮色和暗色字图')
  if (
    merged.watermarkEnabled &&
    merged.watermarkContentType === 'custom' &&
    !normalized.watermarkCustomText
  )
    throw new HttpError(400, '请填写自定义水印内容')
  if (merged.captchaEnabled && !normalized.turnstileSiteKey)
    throw new HttpError(400, '启用登录验证后，请填写 Turnstile Site Key')
  if (merged.maintenanceEnabled && !normalized.maintenanceMessage)
    throw new HttpError(400, '开启维护模式后，请填写维护提示文案')
  const channelError = getAuthChannelValidationMessage(merged.authChannels)
  if (channelError) throw new HttpError(400, channelError)
  if (!Array.isArray(merged.authChannels)) throw new HttpError(400, '认证渠道配置格式无效')
  for (const channel of merged.authChannels) {
    if (
      !isObjectRecord(channel) ||
      Object.keys(channel).some(
        (key) =>
          ![
            'key',
            'label',
            'provider',
            'icon',
            'description',
            'scopes',
            'queryParamName',
            'queryParamValue',
            'enabled',
            'allowLinking'
          ].includes(key)
      ) ||
      typeof channel.enabled !== 'boolean' ||
      typeof channel.allowLinking !== 'boolean' ||
      typeof channel.icon !== 'string' ||
      !/^[a-z0-9-]+:[a-z0-9-]+$/.test(channel.icon) ||
      channel.icon.length > 80 ||
      typeof channel.key !== 'string' ||
      channel.key.length > 40 ||
      typeof channel.label !== 'string' ||
      channel.label.length > 40 ||
      typeof channel.provider !== 'string' ||
      channel.provider.length > 50 ||
      (typeof channel.queryParamName === 'string' &&
        /(^|[._-])(secret|password|token|api[_-]?key)([._-]|$)/i.test(channel.queryParamName)) ||
      ['description', 'scopes', 'queryParamName', 'queryParamValue'].some(
        (key) =>
          channel[key] !== undefined && channel[key] !== null && typeof channel[key] !== 'string'
      ) ||
      (
        [
          ['description', 100],
          ['scopes', 200],
          ['queryParamName', 64],
          ['queryParamValue', 160]
        ] as const
      ).some(([key, max]) => typeof channel[key] === 'string' && channel[key].length > max)
    )
      throw new HttpError(400, '认证渠道配置格式无效')
  }
  normalized.authChannels = normalizeAuthChannels(merged.authChannels)
  if (normalized.authChannels.length !== merged.authChannels.length)
    throw new HttpError(400, '认证渠道配置格式无效')
  return normalized
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
  const input = await body(req, 32768)
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
