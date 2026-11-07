import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { BffBrandingRecord, BffBrandingWriteInput } from '../../src/types/branding'

const brandingId = '11111111-1111-4111-8111-111111111111'
const typeId = '22222222-2222-4222-8222-222222222222'
const timestamp = '2026-11-07T08:30:00Z'

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

async function mockBranding(page: Page, canEdit: boolean) {
  const state = {
    record: initialBranding(),
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
    if (url.pathname === '/api/auth/session' && method === 'GET') {
      await reply({
        user: {
          id: '33333333-3333-4333-8333-333333333333',
          name: '验收管理员',
          email: 'admin@example.test',
          role: canEdit ? 'admin' : 'viewer',
          tenantId: '44444444-4444-4444-8444-444444444444'
        },
        csrfToken: 'synthetic-branding-ui',
        permissions: canEdit ? ['BffBrand:View', 'BffBrand:Edit'] : ['BffBrand:View'],
        branding: state.record,
        menu: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            parentId: null,
            path: '/system/website-config',
            name: 'BffBranding',
            component: '/shared/system/website-config',
            props: { profile: 'branding', canEdit },
            type: 'menu',
            sort: 1,
            meta: { title: '系统配置', icon: 'ri:palette-line', isEnable: true }
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
  const logoUrl = 'https://assets.example.test/bff-logo.svg'
  const faviconUrl = 'https://assets.example.test/bff-favicon.svg'
  await page.getByRole('textbox', { name: 'Logo 图片地址' }).fill(logoUrl)
  await page.getByRole('textbox', { name: '浏览器图标地址' }).fill(faviconUrl)
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
