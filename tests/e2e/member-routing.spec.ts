import { expect, test, type Page } from '@playwright/test'

const adminId = '11111111-1111-4111-8111-111111111111'
const observerId = '22222222-2222-4222-8222-222222222222'
const maintainerId = '33333333-3333-4333-8333-333333333333'
const tenantId = '44444444-4444-4444-8444-444444444444'
const updatedAt = '2026-11-07T08:30:00Z'
const members = [
  {
    id: observerId,
    displayName: '验收示例：接口观察员',
    email: 'observer@example.test',
    role: 'viewer',
    enabled: true,
    version: 1,
    roleNames: ['接口查看'],
    applicationCount: 1,
    sessionCount: 0,
    createdAt: updatedAt,
    updatedAt
  },
  {
    id: maintainerId,
    displayName: '验收示例：服务维护员',
    email: 'maintainer@example.test',
    role: 'viewer',
    enabled: false,
    version: 1,
    roleNames: [],
    applicationCount: 0,
    sessionCount: 0,
    createdAt: updatedAt,
    updatedAt
  }
] as const
const session = {
  user: {
    id: adminId,
    name: '合成管理员',
    email: 'admin@example.test',
    role: 'admin',
    tenantId
  },
  csrfToken: 'synthetic-browser-test',
  permissions: ['System:Member:View', 'System:Member:Edit'],
  menu: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      parentId: null,
      path: '/system/member',
      name: 'User',
      component: '/bff/system/member/index',
      type: 'menu',
      sort: 1,
      meta: { title: '成员管理', icon: 'ri:team-line', isEnable: true }
    }
  ]
}
const pageErrors = new WeakMap<Page, string[]>()
const unexpectedApiRequests = new WeakMap<Page, string[]>()

async function mockBffApi(page: Page): Promise<void> {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET') {
      unexpectedApiRequests.get(page)?.push(`${route.request().method()} ${url.pathname}`)
      await route.fulfill({ status: 405, contentType: 'application/json', body: '{}' })
      return
    }
    let payload: unknown
    switch (url.pathname) {
      case '/api/auth/session':
        payload = session
        break
      case '/api/control/dictionaries':
        payload = { revision: 1, types: [], items: [] }
        break
      case '/api/control/table-columns':
        payload = { mode: 'frontend', profile: null, columns: [] }
        break
      case '/api/control/members':
        payload = { revision: 1, records: members }
        break
      default:
        unexpectedApiRequests.get(page)?.push(`GET ${url.pathname}`)
        await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
        return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload)
    })
  })
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  unexpectedApiRequests.set(page, [])
  page.on('pageerror', (error) => errors.push(error.message))
  await mockBffApi(page)
})

test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([])
  expect(unexpectedApiRequests.get(page)).toEqual([])
})

test('initial dynamic route keeps recordId and hash, then clears the locator', async ({ page }) => {
  await page.goto(`/system/member?recordId=${observerId}#anchor`)

  await expect(page).toHaveURL(new RegExp(`/system/member\\?recordId=${observerId}#anchor$`))
  await expect(page.getByRole('heading', { name: '成员管理' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：接口观察员' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：服务维护员' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '查看全部成员' })).toBeVisible()

  await page.getByRole('button', { name: '查看全部成员' }).click()
  await expect(page).not.toHaveURL(/recordId=/)
  await expect(page.getByRole('row').filter({ hasText: '验收示例：接口观察员' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：服务维护员' })).toBeVisible()
})

test('member keyword search can reach empty state and recover', async ({ page }) => {
  await page.goto('/system/member')
  await expect(page.getByRole('heading', { name: '成员管理' })).toBeVisible()
  const search = page.getByPlaceholder('搜索姓名或邮箱')
  await search.fill('接口观察员')
  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：接口观察员' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：服务维护员' })).toHaveCount(0)

  await search.fill('不存在的成员')
  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByText('暂无符合条件的成员')).toBeVisible()

  await page.getByRole('button', { name: '重置' }).click()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：接口观察员' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：服务维护员' })).toBeVisible()
})
