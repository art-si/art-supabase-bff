import { createWebsiteConfigDefaults } from '@/config/website-config-defaults'
import { BFF_BRANDING_DEFAULTS, type BffBrandingRecord } from '@bff/types/branding'

/** BFF product values; rendering and configuration behavior belong to the pro package. */
export function createBffWebsiteDefaults(): Api.SystemManage.WebsiteConfigItem {
  const defaults = createWebsiteConfigDefaults()
  return {
    ...defaults,
    ...BFF_BRANDING_DEFAULTS,
    authChannels: defaults.authChannels
  }
}

export function websiteConfigFromBranding(
  record: BffBrandingRecord
): Api.SystemManage.WebsiteConfigItem & { version: number } {
  return {
    ...createBffWebsiteDefaults(),
    ...record.config,
    authChannels: record.config.authChannels.map((channel) => ({ ...channel })),
    id: record.id,
    version: record.version,
    createTime: record.createdAt ?? undefined,
    updateTime: record.updatedAt ?? undefined,
    updateBy: record.updatedByName
  }
}
