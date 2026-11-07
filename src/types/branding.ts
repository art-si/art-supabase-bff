import { createWebsiteConfigDefaults } from 'art-supabase-pro/src/config/website-config-defaults'
import type { WebsiteConfigValues } from 'art-supabase-pro/src/types/platform/website-config'

export type BffBrandingConfig = WebsiteConfigValues

export const BFF_BRANDING_DEFAULTS: Readonly<BffBrandingConfig> = Object.freeze({
  ...createWebsiteConfigDefaults(),
  siteName: 'BFF平台',
  siteShortName: 'BFF',
  siteDescription: '企业应用接入与接口服务平台',
  loginTitle: '欢迎使用 BFF 平台',
  loginSubtitle: '统一管理应用、服务与接口',
  loginDescription: '企业应用接入与接口服务平台',
  seoTitle: 'BFF平台',
  seoKeywords: 'BFF,应用管理,接口编排',
  seoDescription: '企业应用接入与接口服务平台',
  copyrightText: '© BFF平台'
})

export interface BffBrandingRecord {
  id: string
  version: number
  config: BffBrandingConfig
  createdAt: string | null
  updatedAt: string | null
  updatedByName: string
}

export interface BffBrandingWriteInput {
  version: number
  config: BffBrandingConfig
}
