import { createWebsiteConfigDefaults } from '@/config/website-config-defaults'
import { BFF_BRANDING_DEFAULTS, type BffBrandingRecord } from '@bff/types/branding'

/** BFF product values; rendering and configuration behavior belong to the pro package. */
export function createBffWebsiteDefaults(): Api.SystemManage.WebsiteConfigItem {
  return {
    ...createWebsiteConfigDefaults(),
    ...BFF_BRANDING_DEFAULTS,
    seoTitle: BFF_BRANDING_DEFAULTS.siteName,
    seoKeywords: 'BFF,应用管理,接口编排',
    seoDescription: BFF_BRANDING_DEFAULTS.siteDescription,
    copyrightText: `© ${BFF_BRANDING_DEFAULTS.siteName}`
  }
}

export function websiteConfigFromBranding(
  record: BffBrandingRecord
): Api.SystemManage.WebsiteConfigItem & { version: number } {
  return {
    ...createBffWebsiteDefaults(),
    ...record.config,
    id: record.id,
    version: record.version,
    seoTitle: record.config.siteName,
    seoDescription: record.config.siteDescription,
    createTime: record.createdAt ?? undefined,
    updateTime: record.updatedAt ?? undefined,
    updateBy: record.updatedByName
  }
}
