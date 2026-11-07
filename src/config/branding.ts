import { createWebsiteConfigDefaults } from '@/config/website-config-defaults'

/** BFF product values; rendering and configuration behavior belong to the pro package. */
export function createBffWebsiteDefaults(): Api.SystemManage.WebsiteConfigItem {
  return {
    ...createWebsiteConfigDefaults(),
    siteName: 'BFF平台',
    siteShortName: 'BFF',
    siteDescription: '企业应用接入与接口服务平台',
    seoTitle: 'BFF平台',
    seoKeywords: 'BFF,应用管理,接口编排',
    seoDescription: '企业应用接入与接口服务平台',
    copyrightText: '© BFF平台'
  }
}
