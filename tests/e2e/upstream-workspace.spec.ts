import { expect, test, type Page } from '@playwright/test'
import type { UpstreamService } from '../../src/types/upstream'

const adminId = '11111111-1111-4111-8111-111111111111'
const tenantId = '22222222-2222-4222-8222-222222222222'
const applicationId = '33333333-3333-4333-8333-333333333333'
const draftId = '44444444-4444-4444-8444-444444444444'
const activeId = '55555555-5555-4555-8555-555555555555'
const createdId = '66666666-6666-4666-8666-666666666666'
const timestamp = '2026-11-07T08:30:00Z'
const application = { id: applicationId, name: '合成测试应用', code: 'fixture-app', enabled: true }

function initialRows(): UpstreamService[] {
  return [
    {
      id: draftId,
      applicationId,
      application,
      code: 'inventory-query',
      name: '验收示例：库存查询服务',
      description: '仅用于本地浏览器回归',
      environment: 'development',
      status: 'draft',
      baseUrl: 'https://inventory.example.test/v1',
      authType: 'none',
      headerName: '',
      timeoutMs: 10_000,
      version: 1,
      configVersion: 1,
      credentialConfigured: false,
      credentialVersion: 0,
      healthStatus: 'unknown',
      lastCheckedAt: null,
      lastStatusCode: null,
      lastDurationMs: null,
      lastHealthMessage: '',
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: activeId,
      applicationId,
      application,
      code: 'order-sync',
      name: '验收示例：订单同步服务',
      description: '仅用于本地浏览器回归',
      environment: 'production',
      status: 'active',
      baseUrl: 'https://orders.example.test/v2',
      authType: 'bearer',
      headerName: 'Authorization',
      timeoutMs: 15_000,
      version: 2,
      configVersion: 1,
      credentialConfigured: true,
      credentialVersion: 1,
      healthStatus: 'reachable',
      lastCheckedAt: timestamp,
      lastStatusCode: 200,
      lastDurationMs: 83,
      lastHealthMessage: '连接正常',
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ]
}

interface MockState {
  rows: UpstreamService[]
  writes: Array<{ method: string; path: string; body: Record<string, unknown> }>
  unexpected: string[]
  pageErrors: string[]
}

async function mockUpstreamApi(page: Page, networkPolicyConfigured: boolean): Promise<MockState> {
  const state: MockState = { rows: initialRows(), writes: [], unexpected: [], pageErrors: [] }
  page.on('pageerror', (error) => state.pageErrors.push(error.message))
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const reply = async (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const jsonBody = (): Record<string, unknown> => {
      const value: unknown = request.postDataJSON()
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected a JSON object from the upstream page')
      return value as Record<string, unknown>
    }

    if (url.pathname === '/api/auth/session' && method === 'GET') {
      await reply({
        user: {
          id: adminId,
          name: '合成管理员',
          email: 'admin@example.test',
          role: 'admin',
          tenantId
        },
        csrfToken: 'synthetic-browser-test',
        permissions: [
          'BffApplication:View',
          'BffUpstream:View',
          'BffUpstream:Add',
          'BffUpstream:Edit',
          'BffUpstream:ChangeStatus',
          'BffUpstream:Test',
          'BffUpstream:RotateSecret',
          'BffUpstream:Delete'
        ],
        menu: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            parentId: null,
            path: '/upstreams',
            name: 'BffUpstreams',
            component: '/bff/upstreams/index',
            type: 'menu',
            sort: 1,
            meta: { title: '上游服务', icon: 'ri:server-line', isEnable: true }
          }
        ]
      })
      return
    }
    if (url.pathname === '/api/control/dictionaries' && method === 'GET') {
      await reply({ revision: 1, types: [], items: [] })
      return
    }
    if (url.pathname === '/api/control/table-columns' && method === 'GET') {
      await reply({ mode: 'frontend', profile: null, columns: [] })
      return
    }
    if (url.pathname === '/api/upstreams/options' && method === 'GET') {
      await reply({
        applications: [application],
        environments: [
          { label: '开发', value: 'development' },
          { label: '预发布', value: 'staging' },
          { label: '生产', value: 'production' }
        ],
        credentialManagementReady: true,
        networkPolicyConfigured
      })
      return
    }
    if (url.pathname === '/api/upstreams' && method === 'GET') {
      const name = (url.searchParams.get('name') || '').toLowerCase()
      const selected = state.rows.filter(
        (row) =>
          (!name || `${row.name} ${row.code}`.toLowerCase().includes(name)) &&
          (!url.searchParams.get('applicationId') ||
            row.applicationId === url.searchParams.get('applicationId')) &&
          (!url.searchParams.get('environment') ||
            row.environment === url.searchParams.get('environment')) &&
          (!url.searchParams.get('status') || row.status === url.searchParams.get('status')) &&
          (!url.searchParams.get('recordId') || row.id === url.searchParams.get('recordId'))
      )
      const current = Number(url.searchParams.get('current')) || 1
      const size = Number(url.searchParams.get('size')) || 20
      await reply({
        records: selected.slice((current - 1) * size, current * size),
        total: selected.length,
        current,
        size,
        summary: {
          total: state.rows.length,
          active: state.rows.filter((row) => row.status === 'active').length,
          draft: state.rows.filter((row) => row.status === 'draft').length,
          disabled: state.rows.filter((row) => row.status === 'disabled').length,
          reachable: state.rows.filter((row) => row.healthStatus === 'reachable').length,
          failed: state.rows.filter((row) => row.healthStatus === 'failed').length
        }
      })
      return
    }
    if (url.pathname === '/api/upstreams' && method === 'POST') {
      const body = jsonBody()
      state.writes.push({ method, path: url.pathname, body })
      const row: UpstreamService = {
        ...initialRows()[0],
        id: createdId,
        code: String(body.code),
        name: String(body.name),
        description: String(body.description),
        baseUrl: String(body.baseUrl),
        authType: body.authType === 'bearer' ? 'bearer' : 'none',
        headerName: String(body.headerName),
        credentialConfigured: typeof body.credential === 'string' && Boolean(body.credential),
        credentialVersion: typeof body.credential === 'string' && body.credential ? 1 : 0
      }
      state.rows.unshift(row)
      await reply(row, 201)
      return
    }
    if (url.pathname === `/api/upstreams/${createdId}` && method === 'PUT') {
      const body = jsonBody()
      state.writes.push({ method, path: url.pathname, body })
      const current = state.rows.find((row) => row.id === createdId)
      if (!current) throw new Error('Synthetic created row is missing')
      const updated: UpstreamService = {
        ...current,
        name: String(body.name),
        description: String(body.description),
        baseUrl: String(body.baseUrl),
        timeoutMs: Number(body.timeoutMs),
        version: current.version + 1
      }
      state.rows = state.rows.map((row) => (row.id === createdId ? updated : row))
      await reply(updated)
      return
    }
    if (url.pathname === `/api/upstreams/${createdId}/credential` && method === 'PUT') {
      const body = jsonBody()
      state.writes.push({ method, path: url.pathname, body })
      const current = state.rows.find((row) => row.id === createdId)
      if (!current) throw new Error('Synthetic created row is missing')
      const updated: UpstreamService = {
        ...current,
        credentialConfigured: body.action === 'rotate',
        credentialVersion: current.credentialVersion + 1,
        version: current.version + 1
      }
      state.rows = state.rows.map((row) => (row.id === createdId ? updated : row))
      await reply(updated)
      return
    }
    if (url.pathname === `/api/upstreams/${createdId}/health-tests` && method === 'POST') {
      const body = jsonBody()
      state.writes.push({ method, path: url.pathname, body })
      const current = state.rows.find((row) => row.id === createdId)
      if (!current) throw new Error('Synthetic created row is missing')
      await reply({
        ...current,
        healthStatus: 'reachable',
        probeStale: true,
        lastHealthMessage: '配置已变化，本次旧结果未应用，请重新测试'
      })
      return
    }
    state.unexpected.push(`${method} ${url.pathname}`)
    await reply({ code: 'UNEXPECTED', message: '测试接口未配置' }, 404)
  })
  return state
}

test('two upstream states, keyword search, empty result and recovery', async ({ page }) => {
  const state = await mockUpstreamApi(page, false)
  await page.goto('/upstreams')
  await expect(page.getByRole('heading', { name: '上游服务' })).toBeVisible()
  await expect(page.getByText('上游网络访问策略待配置')).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存查询服务' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：订单同步服务' })).toBeVisible()

  const keyword = page.getByPlaceholder('搜索名称或编码')
  await keyword.fill('库存查询')
  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存查询服务' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：订单同步服务' })).toHaveCount(0)

  await keyword.fill('不存在的服务')
  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByText('暂无符合条件的上游服务')).toBeVisible()

  await page.getByRole('button', { name: '重置' }).click()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存查询服务' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：订单同步服务' })).toBeVisible()
  expect(state.unexpected).toEqual([])
  expect(state.pageErrors).toEqual([])
})

test('draft creation, metadata edit and write-only credential rotation', async ({ page }) => {
  test.setTimeout(90_000)
  const state = await mockUpstreamApi(page, true)
  await page.goto('/upstreams')
  await expect(page.getByRole('heading', { name: '上游服务' })).toBeVisible()

  await page.getByRole('button', { name: '登记上游服务' }).click()
  const createDialog = page.getByRole('dialog', { name: '登记上游服务' })
  await expect(createDialog).toBeVisible()
  await createDialog.getByPlaceholder('例如：inventory-api').fill('quality-analytics')
  await createDialog.getByPlaceholder('例如：库存查询服务').fill('验收示例：质量分析服务')
  await createDialog
    .getByPlaceholder('https://api.example.com/v1')
    .fill('https://quality.example.test/v1')
  await createDialog.getByText('Bearer Token', { exact: true }).click()
  await createDialog
    .getByPlaceholder('可先留空创建草稿，稍后单独配置凭据')
    .fill('local-fixture-credential')
  await createDialog.getByRole('button', { name: '创建草稿' }).click()
  await expect(createDialog).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: '验收示例：质量分析服务' })).toBeVisible()
  const createRequest = state.writes.find((write) => write.method === 'POST')
  expect(createRequest?.body.credential).toBe('local-fixture-credential')
  expect(createRequest?.body.status).toBeUndefined()

  let row = page.getByRole('row').filter({ hasText: '验收示例：质量分析服务' })
  await row.getByRole('button', { name: '编辑' }).click()
  const editDialog = page.getByRole('dialog', { name: '编辑上游服务' })
  await expect(editDialog).toBeVisible()
  await expect(editDialog.getByPlaceholder('可先留空创建草稿，稍后单独配置凭据')).toHaveCount(0)
  await editDialog.getByPlaceholder('例如：库存查询服务').fill('验收示例：质量分析服务（更新）')
  await editDialog.getByRole('button', { name: '保存配置' }).click()
  await expect(editDialog).toHaveCount(0)
  await expect(page.getByRole('row').filter({ hasText: '质量分析服务（更新）' })).toBeVisible()
  const editRequest = state.writes.find(
    (write) => write.method === 'PUT' && write.path === `/api/upstreams/${createdId}`
  )
  expect(editRequest?.body.credential).toBeUndefined()
  expect(editRequest?.body.code).toBeUndefined()
  expect(editRequest?.body.applicationId).toBeUndefined()
  expect(editRequest?.body.environment).toBeUndefined()

  row = page.getByRole('row').filter({ hasText: '质量分析服务（更新）' })
  await row.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '管理凭据' }).click()
  const credentialDialog = page.getByRole('dialog', { name: '管理上游凭据' })
  await expect(credentialDialog).toBeVisible()
  const credential = credentialDialog.getByPlaceholder('输入新的 Bearer Token 或 API Key')
  await credential.fill('discarded-local-fixture')
  await credentialDialog.getByRole('button', { name: '取消' }).click()
  await expect(credentialDialog).toHaveCount(0)

  await row.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '管理凭据' }).click()
  await expect(credentialDialog.getByPlaceholder('输入新的 Bearer Token 或 API Key')).toHaveValue(
    ''
  )
  await credentialDialog
    .getByPlaceholder('输入新的 Bearer Token 或 API Key')
    .fill('  local-opaque-fixture  ')
  await credentialDialog.getByRole('button', { name: '保存凭据' }).click()
  await expect(credentialDialog).toHaveCount(0)
  const credentialRequest = state.writes.find((write) => write.path.endsWith('/credential'))
  expect(credentialRequest?.body.credential).toBe('  local-opaque-fixture  ')
  expect(state.rows.find((item) => item.id === createdId)).not.toHaveProperty('credential')

  row = page.getByRole('row').filter({ hasText: '质量分析服务（更新）' })
  await row.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '检测连接' }).click()
  await expect(page.getByText('配置已变化，本次旧结果未应用，请重新检测连接。')).toBeVisible()
  await expect(page.getByText('连接正常。检测仅验证网络连通性，不验证上游认证。')).toHaveCount(0)
  expect(state.unexpected).toEqual([])
  expect(state.pageErrors).toEqual([])
})
