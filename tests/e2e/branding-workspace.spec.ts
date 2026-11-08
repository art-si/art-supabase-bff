import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type {
  BffBrandingConfig,
  BffBrandingRecord,
  BffBrandingWriteInput
} from '../../src/types/branding'
import type { BffResource } from '../../src/types/resource'

const brandingId = '11111111-1111-4111-8111-111111111111'
const typeId = '22222222-2222-4222-8222-222222222222'
const timestamp = '2026-11-07T08:30:00Z'
const image = readFileSync(
  new URL(import.meta.resolve('art-supabase-pro/src/assets/images/common/logo.webp'))
)
const icon = readFileSync(
  new URL(import.meta.resolve('art-supabase-pro/src/assets/images/favicon.ico'))
)
function sampleResource(id: number, originName: string): BffResource {
  return {
    id,
    originName,
    tenantId: '44444444-4444-4444-8444-444444444444',
    mimeType: originName.endsWith('.ico') ? 'image/x-icon' : 'image/webp',
    suffix: originName.endsWith('.ico') ? 'ico' : 'webp',
    sizeByte: originName.endsWith('.ico') ? icon.length : image.length,
    sizeInfo: '示例图标',
    version: 2,
    url: `/api/resources/${id}/content`,
    createdAt: timestamp,
    updatedAt: timestamp
  }
}

function initialBranding(): BffBrandingRecord {
  return {
    id: brandingId,
    version: 1,
    config: {
      siteName: 'BFF平台',
      siteShortName: 'BFF',
      siteDescription: '企业应用接入与接口服务平台',
      logoUrl: '',
      faviconUrl: '',
      wordmarkImageEnabled: false,
      wordmarkLightUrl: '',
      wordmarkDarkUrl: '',
      watermarkEnabled: true,
      watermarkContentType: 'username',
      watermarkCustomText: '',
      loginTitle: '欢迎使用 BFF 平台',
      loginSubtitle: '统一管理应用、服务与接口',
      loginDescription: '企业应用接入与接口服务平台',
      defaultLanguage: 'zh',
      captchaEnabled: true,
      captchaType: 'turnstile',
      turnstileSiteKey: '0x4AAAAAADqOIVodNJNAZL57',
      turnstileSize: 'normal',
      turnstileTheme: 'auto',
      captchaMaxAttempts: 0,
      captchaLockMinutes: 10,
      registerEnabled: true,
      authChannels: [],
      maintenanceEnabled: false,
      maintenanceMessage: '',
      seoTitle: 'BFF平台',
      seoKeywords: 'BFF,应用管理,接口编排',
      seoDescription: '企业应用接入与接口服务平台',
      contactEmail: '',
      contactPhone: '',
      contactAddress: '',
      copyrightText: '© BFF平台',
      icpRecord: '',
      policeRecord: '',
      enabled: true
    } satisfies BffBrandingConfig,
    createdAt: timestamp,
    updatedAt: timestamp,
    updatedByName: '验收管理员'
  }
}

async function mockBranding(
  page: Page,
  canPublish: boolean,
  waitForSession?: Promise<void>,
  canGenerate = false
) {
  const state = {
    record: initialBranding(),
    resources: [
      sampleResource(101, '示例品牌标识.webp'),
      sampleResource(102, '示例浏览器图标.ico')
    ],
    uploads: 0,
    wordmarkRequests: [] as string[],
    failWordmark: false,
    writes: [] as BffBrandingWriteInput[],
    conflictNext: false,
    brandingReads: 0,
    organizationReads: 0,
    unexpected: [] as string[],
    errors: [] as string[],
    vueErrors: [] as string[]
  }
  page.on('pageerror', (error) => state.errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('[VueError]'))
      state.vueErrors.push(message.text())
  })
  await page.route(/^https:\/\/assets\.example\.test\//, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#635bff"/><path d="M12 12h24v24H12z" fill="#fff"/></svg>'
    })
  })
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const reply = async (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (/^\/api\/resources\/\d+\/content$/.test(url.pathname)) {
      const item = state.resources.find((row) => row.url === url.pathname)
      await route.fulfill({
        contentType: item?.mimeType ?? 'image/webp',
        body: item?.suffix === 'ico' ? icon : image
      })
      return
    }
    if (url.pathname === '/api/resources' && method === 'GET') {
      const rows = state.resources.filter(
        (item) =>
          !url.searchParams.get('originName') ||
          item.originName.includes(url.searchParams.get('originName')!)
      )
      await reply({ data: rows, total: rows.length })
      return
    }
    if (url.pathname === '/api/resources/upload' && method === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('synthetic-branding-ui')
      expect(request.headers()['content-type']).toContain('multipart/form-data; boundary=')
      const form = await new Request(request.url(), {
        method,
        headers: request.headers(),
        body: request.postDataBuffer()
      }).formData()
      const file = form.get('file')
      expect(file).toBeInstanceOf(File)
      if (!(file instanceof File)) throw new Error('Expected one uploaded file')
      const resource = sampleResource(103 + state.uploads++, file.name)
      state.resources.unshift(resource)
      await reply(resource, 201)
      return
    }
    const resource = /^\/api\/resources\/(\d+)(?:\/(name))?$/.exec(url.pathname)
    if (resource && method === 'PUT') {
      const item = state.resources.find((row) => row.id === Number(resource[1]))!
      const input = request.postDataJSON()
      expect(input.version).toBe(item.version)
      item.originName = input.originName
      item.version += 1
      await reply(item)
      return
    }
    if (url.pathname === '/api/auth/session' && method === 'GET') {
      await waitForSession
      await reply({
        user: {
          id: '33333333-3333-4333-8333-333333333333',
          name: '验收管理员',
          email: 'admin@example.test',
          role: 'admin',
          tenantId: '44444444-4444-4444-8444-444444444444'
        },
        csrfToken: 'synthetic-branding-ui',
        permissions: canPublish
          ? [
              'System:WebsiteConfig:View',
              'System:WebsiteConfig:Publish',
              ...(canGenerate ? ['System:WebsiteConfig:GenerateWordmark'] : []),
              'System:Role:View',
              'BffResource:View',
              'BffResource:Add',
              'BffResource:Edit',
              'BffResource:Delete'
            ]
          : ['System:WebsiteConfig:View', 'System:Role:View', 'BffResource:View'],
        branding: state.record,
        menu: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            parentId: null,
            path: '/system/website-config',
            name: 'BffBranding',
            component: '/shared/system/website-config',
            type: 'menu',
            sort: 1,
            meta: { title: '系统配置', icon: 'ri:palette-line', isEnable: true }
          },
          {
            id: '77777777-7777-4777-8777-777777777777',
            parentId: null,
            path: '/data-center/attachment',
            name: 'BffResources',
            component: '/shared/data-center/attachment',
            type: 'menu',
            sort: 2,
            meta: { title: '资源管理', icon: 'ri:attachment-2', isEnable: true }
          },
          {
            id: '88888888-8888-4888-8888-888888888888',
            parentId: null,
            path: '/system/role',
            name: 'BffRole',
            component: '/shared/system/role',
            type: 'menu',
            sort: 3,
            meta: { title: '角色与权限', icon: 'ri:shield-user-line', isEnable: true }
          },
          {
            id: '99999999-9999-4999-8999-999999999999',
            parentId: null,
            path: '',
            component: '',
            name: 'BffAiConfiguration',
            type: 'menu',
            sort: 4,
            meta: {
              title: 'AI 配置中心',
              icon: 'ri:equalizer-2-line',
              isEnable: true,
              link: 'https://art-si.github.io/art-supabase-pro/#/system/ai-configuration'
            }
          }
        ]
      })
      return
    }
    if (url.pathname === '/api/control/dictionaries' && method === 'GET') {
      const items = [
        ['username', '当前用户'],
        ['username_time', '用户与时间'],
        ['site_name', '系统名称'],
        ['custom', '自定义内容']
      ].map(([value, label], index) => ({
        id: `${index + 1}6666666-6666-4666-8666-666666666666`,
        typeId,
        code: value,
        value,
        label,
        status: '1',
        sort: index + 1,
        dictTypeTable: { code: 'sysWatermarkContentType', name: '水印内容' }
      }))
      await reply({
        revision: 1,
        types: [
          { id: typeId, code: 'sysWatermarkContentType', name: '水印内容', nodeType: 'dictionary' }
        ],
        items
      })
      return
    }
    if (url.pathname === '/api/control/table-columns' && method === 'GET') {
      await reply({ enabled: false, catalog: null, profiles: [] })
      return
    }
    if (url.pathname === '/api/control/organizations' && method === 'GET') {
      state.organizationReads += 1
      await reply([])
      return
    }
    if (url.pathname === '/api/control/roles' && method === 'GET') {
      await reply({
        revision: 1,
        records: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            tenantId: '44444444-4444-4444-8444-444444444444',
            tenant: { tenantCode: 'bff', tenantName: '合成 BFF 空间' },
            organizationId: null,
            organization: null,
            roleName: '平台维护员',
            roleCode: 'platform-operator',
            description: '维护接口与资源',
            enabled: true,
            builtinType: 'member',
            version: 1,
            createTime: timestamp
          },
          {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            tenantId: '44444444-4444-4444-8444-444444444444',
            tenant: { tenantCode: 'bff', tenantName: '合成 BFF 空间' },
            organizationId: null,
            organization: null,
            roleName: '审计观察员',
            roleCode: 'audit-viewer',
            description: '只读查看运行记录',
            enabled: true,
            builtinType: 'member',
            version: 1,
            createTime: timestamp
          }
        ]
      })
      return
    }
    if (url.pathname === '/api/control/branding/wordmark' && method === 'POST') {
      expect(request.headers()['x-csrf-token']).toBe('synthetic-branding-ui')
      const input: unknown = request.postDataJSON()
      if (
        !input ||
        typeof input !== 'object' ||
        !('siteName' in input) ||
        typeof input.siteName !== 'string'
      )
        throw new Error('Expected a wordmark site name')
      state.wordmarkRequests.push(input.siteName)
      if (state.failWordmark) {
        state.failWordmark = false
        await reply({ message: '验收：字图服务暂时不可用' }, 503)
      } else {
        await reply({
          imageBase64: image.toString('base64'),
          mimeType: 'image/webp',
          runId: 'fixture-wordmark',
          model: 'fixture',
          generatedAt: timestamp
        })
      }
      return
    }
    if (url.pathname === '/api/control/branding' && method === 'GET') {
      state.brandingReads += 1
      await reply(state.record)
      return
    }
    if (url.pathname === '/api/control/branding' && method === 'POST') {
      const input: unknown = request.postDataJSON()
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('config' in input))
        throw new Error('Expected versioned branding write')
      const command = input as BffBrandingWriteInput
      state.writes.push(command)
      if (!canPublish) {
        await reply({ code: 'FORBIDDEN', message: '没有品牌配置编辑权限' }, 403)
        return
      }
      if (state.conflictNext || command.version !== state.record.version) {
        state.conflictNext = false
        await reply({ code: 'CONFLICT', message: '配置已被其他人更新' }, 409)
        return
      }
      state.record = {
        ...state.record,
        version: state.record.version + 1,
        config: structuredClone(command.config),
        updatedAt: timestamp
      }
      await reply(state.record)
      return
    }
    state.unexpected.push(`${method} ${url.pathname}`)
    await reply({ code: 'UNEXPECTED', message: '未配置的合成接口' }, 404)
  })
  return state
}

test('shared full website page saves two configurations and keeps edits after CAS conflict', async ({
  page
}) => {
  test.setTimeout(80_000)
  const state = await mockBranding(page, true)
  await page.goto('/system/website-config')
  await expect(page.getByRole('heading', { name: '网站配置' })).toBeVisible()
  await expect(page.getByRole('button', { name: '登录体验' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'SEO 展现' })).toBeVisible()
  await expect(
    page.locator('.el-switch').filter({ has: page.getByRole('switch', { name: '使用品牌字图' }) })
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '保存并发布配置' })).toBeDisabled()
  const siteName = page.getByRole('textbox', { name: '系统名称' })
  const loginTitle = page.getByRole('textbox', { name: '登录欢迎标题' })
  const seoTitle = page.getByRole('textbox', { name: 'SEO 标题' })
  await siteName.fill('验收示例：接口平台')
  await loginTitle.fill('欢迎使用接口平台')
  await seoTitle.fill('接口平台服务')
  await page.getByRole('button', { name: '保存并发布配置' }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0]).toMatchObject({
    version: 1,
    config: {
      siteName: '验收示例：接口平台',
      loginTitle: '欢迎使用接口平台',
      seoTitle: '接口平台服务'
    }
  })
  expect(Object.keys(state.writes[0].config).length).toBeGreaterThan(30)
  await expect(page.getByText('网站配置已发布')).toBeVisible()
  await expect(page.locator('.art-logo__wordmark').first()).toHaveText('验收示例：接口平台')
  await expect.poll(() => page.title()).toBe('接口平台服务')

  await siteName.fill('验收示例：服务平台')
  await seoTitle.fill('服务平台应用')
  await page
    .locator('#seo input[type="file"]')
    .first()
    .setInputFiles({ name: '上传系统标识.webp', mimeType: 'image/webp', buffer: image })
  await expect.poll(() => state.uploads).toBe(1)
  await expect(
    page.locator('#seo').getByRole('img', { name: '上传系统标识.webp' })
  ).toHaveAttribute('src', '/api/resources/103/content')
  await page.getByRole('button', { name: '从资源库选择图片' }).click()
  const picker = page.getByRole('dialog', { name: '资源选择器' })
  await picker.getByRole('button', { name: '选择资源 示例浏览器图标.ico' }).click()
  await picker.getByRole('button', { name: '确认', exact: true }).click()
  const logoUrl = '/api/resources/103/content'
  const faviconUrl = '/api/resources/102/content'
  await page.getByRole('combobox', { name: '水印内容' }).click()
  await page.getByRole('option', { name: '系统名称' }).click()
  await page.getByRole('button', { name: '保存并发布配置' }).click()
  await expect.poll(() => state.writes.length).toBe(2)
  expect(state.writes[1]).toMatchObject({
    version: 2,
    config: {
      siteName: '验收示例：服务平台',
      seoTitle: '服务平台应用',
      logoUrl,
      faviconUrl,
      watermarkContentType: 'site_name'
    }
  })
  await expect(siteName).toHaveValue('验收示例：服务平台')
  await expect(page.locator('.art-logo__wordmark').first()).toHaveText('验收示例：服务平台')
  await expect(page.locator('.art-logo__mark').first()).toHaveAttribute('src', logoUrl)
  await expect.poll(() => page.title()).toBe('服务平台应用')
  await expect
    .poll(() => page.locator('link[rel~="icon"]').first().getAttribute('href'))
    .toBe(faviconUrl)
  expect(
    await page
      .locator('.art-logo__mark')
      .first()
      .evaluate(
        (image) =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0
      )
  ).toBe(true)
  const websiteEvidence = path.resolve('.artifacts/ui/website-config')
  mkdirSync(websiteEvidence, { recursive: true })
  await page.getByRole('button', { name: '状态概览' }).click()
  await page.screenshot({ path: path.join(websiteEvidence, 'full-website-light-1440.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    )
    .toBeLessThanOrEqual(1)
  await page.screenshot({ path: path.join(websiteEvidence, 'full-website-light-390.png') })
  await page.setViewportSize({ width: 1440, height: 900 })

  await expect(page.locator('.el-message').filter({ hasText: '网站配置已发布' })).toHaveCount(0)
  const readCountBeforeConflict = state.brandingReads
  const versionBeforeConflict = state.record.version
  state.conflictNext = true
  await siteName.fill('验收示例：并发修改待保留')
  await page.getByRole('button', { name: '保存并发布配置' }).click()
  const conflictNotice = page.locator('.el-message').filter({
    hasText: '配置已被其他人更新。当前输入已保留，请刷新页面核对后重试'
  })
  await expect(conflictNotice).toHaveCount(1)
  await expect(page.locator('.el-message')).toHaveCount(1)
  await expect(siteName).toHaveValue('验收示例：并发修改待保留')
  expect(state.writes[2]?.version).toBe(3)
  expect(state.record.version).toBe(versionBeforeConflict)
  expect(state.brandingReads).toBe(readCountBeforeConflict)
  await expect(page.locator('.el-message').filter({ hasText: '网站配置已发布' })).toHaveCount(0)
  const screenshotPath = path.resolve('.artifacts/ui/branding-cas-conflict.png')
  mkdirSync(path.dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath })
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
  expect(state.vueErrors).toEqual([])
})

test('pro AI wordmark entry retries generation, uploads both themes and publishes their URLs', async ({
  page
}) => {
  const state = await mockBranding(page, true, undefined, true)
  await page.goto('/system/website-config')
  await page.getByRole('button', { name: '系统标识', exact: true }).click()
  await page.getByRole('switch', { name: '使用品牌字图' }).locator('..').click()
  const generate = page.getByRole('button', { name: 'AI 艺术字生成' })
  await expect(generate).toBeEnabled()
  state.failWordmark = true
  await generate.click()
  await expect(page.getByText('验收：字图服务暂时不可用')).toBeVisible()
  expect(state.uploads).toBe(0)
  await generate.click()
  await expect.poll(() => state.uploads).toBe(2)
  await expect(page.getByText('同款浅色与深色菜单字图已生成，请确认文字无误后再发布')).toBeVisible()
  expect(state.wordmarkRequests).toEqual([
    state.record.config.siteName,
    state.record.config.siteName
  ])
  expect(state.writes).toHaveLength(0)
  mkdirSync(path.resolve('.artifacts/ui'), { recursive: true })
  await page.screenshot({ path: '.artifacts/ui/branding-ai-wordmark.png', fullPage: true })
  await page.getByRole('button', { name: '保存并发布配置' }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0].config.wordmarkImageEnabled).toBe(true)
  expect(state.writes[0].config.wordmarkLightUrl).toMatch(/^\/api\/resources\/10[34]\/content$/)
  expect(state.writes[0].config.wordmarkDarkUrl).toMatch(/^\/api\/resources\/10[34]\/content$/)
  expect(state.writes[0].config.wordmarkLightUrl).not.toBe(state.writes[0].config.wordmarkDarkUrl)
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('publishing permission alone does not expose AI generation', async ({ page }) => {
  const state = await mockBranding(page, true)
  await page.goto('/system/website-config')
  await page.getByRole('button', { name: '系统标识', exact: true }).click()
  await page.getByRole('switch', { name: '使用品牌字图' }).locator('..').click()
  await expect(page.getByRole('button', { name: 'AI 艺术字生成' })).toHaveCount(0)
  expect(state.wordmarkRequests).toHaveLength(0)
})

test('shared full website page is read only without System:WebsiteConfig:Publish', async ({
  page
}) => {
  const state = await mockBranding(page, false)
  await page.goto('/system/website-config')
  await expect(page.getByRole('heading', { name: '网站配置' })).toBeVisible()
  await expect(page.getByRole('button', { name: '登录体验' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'SEO 展现' })).toBeVisible()
  await expect(page.getByText('仅平台超级管理员可发布')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存并发布配置' })).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '系统名称' })).toBeDisabled()
  const screenshotPath = path.resolve('.artifacts/ui/branding-readonly.png')
  mkdirSync(path.dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath })
  expect(state.writes).toHaveLength(0)
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('refresh uses the pro loader and the npm resource workspace handles two assets', async ({
  page
}) => {
  const gate = Promise.withResolvers<void>()
  const state = await mockBranding(page, true, gate.promise)
  await page.goto('/data-center/attachment', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('status', { name: '系统正在加载，请稍候' })).toBeVisible()
  mkdirSync(path.resolve('.artifacts/ui/resources'), { recursive: true })
  await page.screenshot({
    path: path.resolve('.artifacts/ui/resources/shared-refresh-loading.png')
  })
  gate.resolve()
  await expect(page.getByRole('heading', { name: '资源管理', exact: true })).toBeVisible()
  await expect(page.getByRole('status', { name: '系统正在加载，请稍候' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '选择资源 示例品牌标识.webp' })).toBeVisible()
  await expect(page.getByRole('button', { name: '选择资源 示例浏览器图标.ico' })).toBeVisible()
  const favicon = await page.locator('link[rel~="icon"]').first().getAttribute('href')
  expect(favicon).toMatch(/favicon(?:-[^/]+)?\.ico/)
  await page
    .locator('input[name="local-image-upload"]')
    .setInputFiles({ name: '上传资源示例.webp', mimeType: 'image/webp', buffer: image })
  await expect(page.getByRole('button', { name: '选择资源 上传资源示例.webp' })).toBeVisible()
  await page
    .locator('.resource-item')
    .filter({ hasText: '上传资源示例.webp' })
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click()
  const rename = page.getByRole('dialog', { name: '重命名附件' })
  await rename.getByRole('textbox').fill('资源验收改名')
  await rename.getByRole('button', { name: '保存名称', exact: true }).click()
  await expect(page.getByRole('button', { name: '选择资源 资源验收改名.webp' })).toBeVisible()
  for (const scenario of [
    { name: 'light-1440', width: 1440, dark: false },
    { name: 'dark-1280', width: 1280, dark: true },
    { name: 'light-390', width: 390, dark: false }
  ]) {
    await page.setViewportSize({ width: scenario.width, height: 900 })
    await page.evaluate((dark) => {
      document.documentElement.classList.toggle('dark', dark)
      document.documentElement.dataset.boxMode = dark ? 'shadow-mode' : 'border-mode'
    }, scenario.dark)
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      )
      .toBeLessThanOrEqual(1)
    await page.screenshot({
      path: path.resolve(`.artifacts/ui/resources/workspace-${scenario.name}.png`),
      animations: 'disabled'
    })
  }
  expect(state.resources).toHaveLength(3)
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('shared role page retains organization filtering with an empty BFF organization directory', async ({
  page
}) => {
  const state = await mockBranding(page, true)
  const proRestRequests: string[] = []
  await page.route(/^https:\/\/[^/]+\/rest\/v1\//, async (route) => {
    proRestRequests.push(route.request().url())
    await route.fulfill({ status: 500, contentType: 'application/json', body: '[]' })
  })
  await page.goto('/system/role')
  await expect(page.getByRole('heading', { name: '角色与权限' })).toBeVisible()
  await expect(page.locator('.role-page__organization-panel')).toBeVisible()
  await expect(page.getByText('暂无组织结构')).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '平台维护员' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '审计观察员' })).toBeVisible()
  expect(state.organizationReads).toBeGreaterThan(0)
  expect(proRestRequests).toEqual([])
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})
