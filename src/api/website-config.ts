import { normalizeNonNullableText } from '@/utils/form/normalize'
import { BffApiError, call } from '@bff/api/bff'
import { websiteConfigFromBranding } from '@bff/config/branding'
import type { BffBrandingRecord, BffBrandingWriteInput } from '@bff/types/branding'

type WebsiteConfig = Api.SystemManage.WebsiteConfigItem & { version?: number }

/** Supplies the common pro page/composable with the current BFF tenant's public brand values. */
export async function fetchWebsiteConfig(): Promise<{ data: WebsiteConfig; error: null }> {
  const record = await call<BffBrandingRecord>('/api/control/branding')
  return {
    data: websiteConfigFromBranding(record),
    error: null
  }
}

export async function saveWebsiteConfig(params: WebsiteConfig): Promise<{ error: null }> {
  if (
    typeof params.version !== 'number' ||
    !Number.isSafeInteger(params.version) ||
    params.version < 0
  )
    throw new BffApiError('配置版本缺失，请重新加载后再保存', 409)
  const input: BffBrandingWriteInput = {
    version: params.version,
    config: {
      siteName: normalizeNonNullableText(params.siteName),
      siteShortName: normalizeNonNullableText(params.siteShortName),
      siteDescription: normalizeNonNullableText(params.siteDescription),
      logoUrl: normalizeNonNullableText(params.logoUrl),
      faviconUrl: normalizeNonNullableText(params.faviconUrl),
      watermarkEnabled: params.watermarkEnabled,
      watermarkContentType: params.watermarkContentType,
      watermarkCustomText: normalizeNonNullableText(params.watermarkCustomText)
    }
  }
  await call('/api/control/branding', { method: 'POST', body: JSON.stringify(input) })
  return { error: null }
}

/** The shared full-profile module can import this symbol; BFF branding never invokes it. */
export const generateWebsiteWordmark: typeof import('art-supabase-pro/src/api/system-manage/website-config').generateWebsiteWordmark =
  async () => {
    throw new BffApiError('当前平台未启用品牌字图生成', 403)
  }
