import { dictionarySnapshot } from '../fixtures/dictionaries'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { ApplicationMember, BffApplication } from '../../src/types/bff'

const appA = '11111111-1111-4111-8111-111111111111'
const appB = '22222222-2222-4222-8222-222222222222'
const viewer = '33333333-3333-4333-8333-333333333333'
const admin = '44444444-4444-4444-8444-444444444444'
const timestamp = '2026-11-07T08:30:00Z'

async function mockApplications(page: Page) {
  const applications: BffApplication[] = [
    {
      id: appA,
      code: 'inventory-workspace',
      name: '验收示例：库存工作台',
      description: '库存查询与作业看板',
      homeUrl: 'https://inventory.example.test',
      enabled: true,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: appB,
      code: 'order-workspace',
      name: '验收示例：订单工作台',
      description: '订单处理与审核',
      homeUrl: 'https://orders.example.test',
      enabled: true,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ]
  const members: ApplicationMember[] = [
    {
      id: admin,
      name: '验收管理员',
      email: 'admin@example.test',
      role: 'admin',
      enabled: true,
      granted: true
    },
    {
      id: viewer,
      name: '验收观察员',
      email: 'viewer@example.test',
      role: 'viewer',
      enabled: true,
      granted: false
    }
  ]
  const state = { writes: [] as Array<{ path: string; granted: boolean }>, errors: [] as string[] }
  page.on('pageerror', (error) => state.errors.push(error.message))
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const reply = async (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (url.pathname === '/api/auth/session' && method === 'GET') {
      await reply({
        user: {
          id: admin,
          name: '验收管理员',
          email: 'admin@example.test',
          role: 'admin',
          tenantId: '55555555-5555-4555-8555-555555555555'
        },
        csrfToken: 'synthetic-application-ui',
        permissions: [
          'BffApplication:View',
          'BffApplication:Add',
          'BffApplication:Edit',
          'BffApplication:Grant'
        ],
        menu: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            parentId: null,
            path: '/applications',
            name: 'BffApplications',
            component: '/bff/applications/index',
            type: 'menu',
            sort: 1,
            meta: { title: '应用管理', icon: 'ri:apps-2-line', isEnable: true }
          }
        ]
      })
      return
    }
    if (url.pathname === '/api/control/dictionaries' && method === 'GET') {
      await reply(dictionarySnapshot())
      return
    }
    if (url.pathname === '/api/control/table-columns' && method === 'GET') {
      await reply({ mode: 'frontend', profile: null, columns: [] })
      return
    }
    if (url.pathname === '/api/applications' && method === 'GET') {
      const name = (url.searchParams.get('name') || '').toLowerCase()
      const records = applications.filter((item) => !name || item.name.toLowerCase().includes(name))
      await reply({ records, total: records.length, current: 1, size: 20 })
      return
    }
    if (url.pathname === `/api/applications/${appA}/members` && method === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await reply(members)
      return
    }
    if (url.pathname === `/api/applications/${appA}/members/${viewer}` && method === 'PUT') {
      const value: unknown = request.postDataJSON()
      if (!value || typeof value !== 'object' || !('granted' in value))
        throw new Error('Expected scoped membership command')
      const granted = (value as { granted: boolean }).granted
      members[1].granted = granted
      state.writes.push({ path: url.pathname, granted })
      await reply({ saved: true })
      return
    }
    await reply({ code: 'UNEXPECTED', message: `${method} ${url.pathname}` }, 404)
    state.errors.push(`Unexpected API: ${method} ${url.pathname}`)
  })
  return state
}

test('application focus mode and member authorization keep shared layout in light, dark and mobile', async ({
  page
}) => {
  test.setTimeout(80_000)
  const state = await mockApplications(page)
  const artifactRoot = path.resolve('.artifacts/ui')
  mkdirSync(artifactRoot, { recursive: true })
  await page.goto('/applications')
  await expect(page.getByRole('heading', { name: '应用管理' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存工作台' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：订单工作台' })).toBeVisible()
  await page.screenshot({ path: path.join(artifactRoot, 'applications-light-1440.png') })

  await page
    .locator('.el-switch')
    .filter({ has: page.getByRole('switch', { name: '进入专注模式' }) })
    .click()
  await expect(page.getByRole('button', { name: '退出专注模式' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '应用管理' })).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存工作台' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '应用管理' })).toBeVisible()

  const row = page.getByRole('row').filter({ hasText: '验收示例：库存工作台' })
  await row.getByRole('button', { name: '成员授权' }).click()
  const dialog = page.getByRole('dialog', { name: '成员授权' })
  await expect(dialog.getByText('成员访问范围')).toBeVisible()
  await expect(dialog.getByText('验收示例：库存工作台')).toBeVisible()
  await expect(dialog.getByText('验收管理员')).toBeVisible()
  await expect(dialog.getByText('验收观察员')).toBeVisible()
  await expect(dialog.getByText('验收观察员')).toBeInViewport()
  expect(
    await dialog.getByText('验收观察员').evaluate((element) => {
      const row = element.closest('tr')
      const table = element.closest('.art-table')
      return Boolean(
        row && table && row.getBoundingClientRect().bottom <= table.getBoundingClientRect().bottom
      )
    })
  ).toBe(true)
  await page.waitForTimeout(350)
  await page.screenshot({ path: path.join(artifactRoot, 'application-members-light-1440.png') })
  await dialog.getByRole('switch', { name: '授权 验收观察员 访问应用' }).locator('..').click()
  await expect.poll(() => state.writes.length).toBe(1)
  expect(state.writes[0]).toEqual({
    path: `/api/applications/${appA}/members/${viewer}`,
    granted: true
  })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
    document.documentElement.dataset.boxMode = 'shadow-mode'
  })
  await row.getByRole('button', { name: '成员授权' }).click()
  await expect(dialog.getByText('成员访问范围')).toBeVisible()
  await expect(dialog.getByText('验收观察员')).toBeVisible()
  await page.waitForTimeout(350)
  await page.screenshot({ path: path.join(artifactRoot, 'application-members-dark-1280.png') })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.dataset.boxMode = 'border-mode'
  })
  await row.getByRole('button', { name: '成员授权' }).click()
  await expect(dialog.getByText('成员访问范围')).toBeVisible()
  await expect(dialog.getByText('验收观察员')).toBeVisible()
  await page.waitForTimeout(350)
  await page.screenshot({ path: path.join(artifactRoot, 'application-members-mobile-390.png') })
  expect(state.errors).toEqual([])
})
