import { omit } from 'lodash-es'
import { BffApiError, bffSession, call } from '@bff/api/bff'
import { websiteConfigFromBranding } from '@bff/config/branding'
import type { BffBrandingRecord, BffBrandingWriteInput } from '@bff/types/branding'

type WebsiteConfig = Api.SystemManage.WebsiteConfigItem

/** Supplies the common pro page/composable with the current BFF tenant's public brand values. */
export async function fetchWebsiteConfig(): Promise<{
  data: WebsiteConfig
  error: null
  canPublish: boolean
}> {
  const record = await call<BffBrandingRecord>('/api/control/branding')
  return {
    data: websiteConfigFromBranding(record),
    error: null,
    canPublish: Boolean(bffSession.value?.permissions.includes('System:WebsiteConfig:Publish'))
  }
}

export async function saveWebsiteConfig(params: WebsiteConfig): Promise<{ error: unknown | null }> {
  if (
    typeof params.version !== 'number' ||
    !Number.isSafeInteger(params.version) ||
    params.version < 0
  )
    return { error: new BffApiError('配置版本缺失，请重新加载后再保存', 409) }
  const input: BffBrandingWriteInput = {
    version: params.version,
    config: omit(params, [
      'id',
      'version',
      'tenantId',
      'paramMeta',
      'createBy',
      'createTime',
      'updateBy',
      'updateTime'
    ])
  }
  try {
    await call('/api/control/branding', { method: 'POST', body: JSON.stringify(input) })
  } catch (error) {
    return {
      error:
        error instanceof BffApiError && error.status === 409
          ? new Error('配置已被其他人更新。当前输入已保留，请刷新页面核对后重试', {
              cause: error
            })
          : error instanceof BffApiError
            ? error
            : new Error('网站配置发布失败，请稍后重试', { cause: error })
    }
  }
  return { error: null }
}

export const generateWebsiteWordmark: typeof import('art-supabase-pro/src/api/system-manage/website-config').generateWebsiteWordmark =
  (params) =>
    call('/api/control/branding/wordmark', { method: 'POST', body: JSON.stringify(params) })
