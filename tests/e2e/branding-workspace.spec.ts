import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { BffBrandingRecord, BffBrandingWriteInput } from '../../src/types/branding'
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
      watermarkEnabled: true,
      watermarkContentType: 'username',
      watermarkCustomText: ''
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    updatedByName: '验收管理员'
  }
}

async function mockBranding(page: Page, canEdit: boolean, waitForSession?: Promise<void>) {
  const state = {
    record: initialBranding(),
    resources: [
      sampleResource(101, '示例品牌标识.webp'),
      sampleResource(102, '示例浏览器图标.ico')
    ],
    uploads: 0,
    writes: [] as BffBrandingWriteInput[],
    conflictNext: false,
    unexpected: [] as string[],
    errors: [] as string[]
  }
  page.on('pageerror', (error) => state.errors.push(error.message))
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
          role: canEdit ? 'admin' : 'viewer',
          tenantId: '44444444-4444-4444-8444-444444444444'
        },
        csrfToken: 'synthetic-branding-ui',
        permissions: canEdit
          ? [
              'BffBrand:View',
              'BffBrand:Edit',
              'BffResource:View',
              'BffResource:Add',
              'BffResource:Edit',
              'BffResource:Delete'
            ]
          : ['BffBrand:View', 'BffResource:View'],
        branding: state.record,
        menu: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            parentId: null,
            path: '/system/website-config',
            name: 'BffBranding',
            component: '/shared/system/website-config',
            props: {
              profile: 'branding',
              canEdit,
              resourceTenantId: '44444444-4444-4444-8444-444444444444',
              resourceCanView: true,
              resourceCanUpload: canEdit,
              resourceCanEdit: canEdit,
              resourceCanDelete: canEdit
            },
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
            props: {
              title: '资源管理',
              canView: true,
              canUpload: canEdit,
              canRename: canEdit,
              canDelete: canEdit
            },
            type: 'menu',
            sort: 2,
            meta: { title: '资源管理', icon: 'ri:attachment-2', isEnable: true }
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
      await reply({ mode: 'frontend', profile: null, columns: [] })
      return
    }
    if (url.pathname === '/api/control/branding' && method === 'GET') {
      await reply(state.record)
      return
    }
    if (url.pathname === '/api/control/branding' && method === 'POST') {
      const input: unknown = request.postDataJSON()
      if (!input || typeof input !== 'object' || Array.isArray(input) || !('config' in input))
        throw new Error('Expected versioned branding write')
      const command = input as BffBrandingWriteInput
      state.writes.push(command)
      if (!canEdit) {
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

test('shared pro brand page saves two distinct BFF configurations and preserves input on CAS conflict', async ({
  page
}) => {
  test.setTimeout(80_000)
  const state = await mockBranding(page, true)
  await page.goto('/system/website-config')
  await expect(page.getByRole('heading', { name: '系统品牌' })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存品牌配置' })).toBeDisabled()
  const siteName = page.getByRole('textbox', { name: '系统名称' })
  await siteName.fill('验收示例：接口平台')
  await page.getByRole('button', { name: '保存品牌配置' }).click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0]).toMatchObject({ version: 1, config: { siteName: '验收示例：接口平台' } })
  await expect(page.getByText('品牌配置已保存')).toBeVisible()
  await expect(page.locator('.art-logo__wordmark').first()).toHaveText('验收示例：接口平台')
  await expect.poll(() => page.title()).toBe('验收示例：接口平台')

  await siteName.fill('验收示例：服务平台')
  await page
    .locator('#identity input[type="file"]')
    .first()
    .setInputFiles({ name: '上传系统标识.webp', mimeType: 'image/webp', buffer: image })
  await expect.poll(() => state.uploads).toBe(1)
  await expect(page.locator('.website-config-page__brand-preview')).toHaveAttribute(
    'src',
    '/api/resources/103/content'
  )
  await page.getByRole('button', { name: '从资源库选择图片' }).click()
  const picker = page.getByRole('dialog', { name: '资源选择器' })
  await picker.getByRole('button', { name: '选择资源 示例浏览器图标.ico' }).click()
  await picker.getByRole('button', { name: '确认', exact: true }).click()
  const logoUrl = '/api/resources/103/content'
  const faviconUrl = '/api/resources/102/content'
  await page.getByRole('combobox', { name: '水印内容' }).click()
  await page.getByRole('option', { name: '系统名称' }).click()
  await page.getByRole('button', { name: '保存品牌配置' }).click()
  await expect.poll(() => state.writes.length).toBe(2)
  expect(state.writes[1]).toMatchObject({
    version: 2,
    config: {
      siteName: '验收示例：服务平台',
      logoUrl,
      faviconUrl,
      watermarkContentType: 'site_name'
    }
  })
  await expect(siteName).toHaveValue('验收示例：服务平台')
  await expect(page.locator('.art-logo__wordmark').first()).toHaveText('验收示例：服务平台')
  await expect(page.locator('.art-logo__mark').first()).toHaveAttribute('src', logoUrl)
  await expect.poll(() => page.title()).toBe('验收示例：服务平台')
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

  state.conflictNext = true
  await siteName.fill('验收示例：并发修改待保留')
  await page.getByRole('button', { name: '保存品牌配置' }).click()
  await expect(page.getByText('配置已被其他人更新。当前输入已保留')).toBeVisible()
  await expect(siteName).toHaveValue('验收示例：并发修改待保留')
  expect(state.writes[2]?.version).toBe(3)
  const screenshotPath = path.resolve('.artifacts/ui/branding-cas-conflict.png')
  mkdirSync(path.dirname(screenshotPath), { recursive: true })
  await page.getByText('配置已被其他人更新。当前输入已保留').scrollIntoViewIfNeeded()
  await page.screenshot({ path: screenshotPath })
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('shared pro brand page is read only without BffBrand:Edit', async ({ page }) => {
  const state = await mockBranding(page, false)
  await page.goto('/system/website-config')
  await expect(page.getByRole('heading', { name: '系统品牌' })).toBeVisible()
  await expect(page.getByText('当前账号没有品牌配置编辑权限')).toBeVisible()
  await expect(page.getByRole('button', { name: '保存品牌配置' })).toHaveCount(0)
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
