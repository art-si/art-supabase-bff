export interface BffBrandingConfig {
  siteName: string
  siteShortName: string
  siteDescription: string
  logoUrl: string
  faviconUrl: string
  watermarkEnabled: boolean
  watermarkContentType: 'username' | 'username_time' | 'site_name' | 'custom'
  watermarkCustomText: string
}

export const BFF_BRANDING_DEFAULTS: Readonly<BffBrandingConfig> = Object.freeze({
  siteName: 'BFF平台',
  siteShortName: 'BFF',
  siteDescription: '企业应用接入与接口服务平台',
  logoUrl: '',
  faviconUrl: '',
  watermarkEnabled: true,
  watermarkContentType: 'username',
  watermarkCustomText: ''
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
