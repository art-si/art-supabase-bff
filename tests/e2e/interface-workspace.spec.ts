import { dictionarySnapshot } from '../fixtures/dictionaries'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type {
  InterfaceBinding,
  InterfaceDefinition,
  InterfaceRecord,
  InterfaceWriteInput
} from '../../src/types/interface'

const applicationId = '11111111-1111-4111-8111-111111111111'
const orderUpstreamId = '22222222-2222-4222-8222-222222222222'
const detailUpstreamId = '33333333-3333-4333-8333-333333333333'
const firstId = '44444444-4444-4444-8444-444444444444'
const secondId = '55555555-5555-4555-8555-555555555555'
const createdId = '66666666-6666-4666-8666-666666666666'
const timestamp = '2026-11-07T08:30:00Z'
const application = { id: applicationId, code: 'demo-app', name: '合成业务应用', enabled: true }

function binding(
  target: string,
  source: InterfaceBinding['source'],
  key: string,
  pointer = ''
): InterfaceBinding {
  return {
    target,
    source,
    inputKey: source === 'input' ? key : '',
    stepKey: source === 'step' ? key : '',
    pointer,
    literalType: 'string',
    literalValue: ''
  }
}
function twoStepDefinition(): InterfaceDefinition {
  return {
    inputs: [
      { key: 'orderId', label: '订单编号', location: 'path', type: 'string', required: true }
    ],
    steps: [
      {
        key: 'fetchOrder',
        name: '查询订单',
        upstreamId: orderUpstreamId,
        configVersion: 1,
        method: 'GET',
        path: '/orders/{orderId}',
        pathParams: [binding('orderId', 'input', 'orderId')],
        query: [],
        body: []
      },
      {
        key: 'fetchItems',
        name: '查询明细',
        upstreamId: detailUpstreamId,
        configVersion: 2,
        method: 'GET',
        path: '/orders/{orderId}/items',
        pathParams: [binding('orderId', 'input', 'orderId')],
        query: [],
        body: []
      }
    ],
    outputs: [
      binding('status', 'step', 'fetchOrder', '/status'),
      binding('total', 'step', 'fetchItems', '/total')
    ]
  }
}
function initialRows(): InterfaceRecord[] {
  const definition = twoStepDefinition()
  return [
    {
      id: firstId,
      applicationId,
      application,
      environment: 'development',
      code: 'order-query',
      name: '验收示例：订单查询接口',
      description: '合成两步编排',
      method: 'GET',
      path: '/orders/{orderId}',
      definition: structuredClone(definition),
      version: 2,
      validationStatus: 'valid',
      validatedVersion: 2,
      validationIssues: [],
      lastValidatedAt: timestamp,
      lastTestStatus: 'passed',
      lastTestVersion: 2,
      lastTestAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      id: secondId,
      applicationId,
      application,
      environment: 'development',
      code: 'stock-check',
      name: '验收示例：库存核对接口',
      description: '合成两步编排',
      method: 'GET',
      path: '/stock/{orderId}',
      definition: structuredClone(definition),
      version: 1,
      validationStatus: 'unvalidated',
      validatedVersion: null,
      validationIssues: [],
      lastValidatedAt: null,
      lastTestStatus: 'not_tested',
      lastTestVersion: null,
      lastTestAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ]
}

interface MockState {
  rows: InterfaceRecord[]
  writes: Array<{ method: string; path: string; body: Record<string, unknown> }>
  unexpected: string[]
  errors: string[]
  testRuns: number
}

/** The route fixture checks the JSON boundary before presenting a typed synthetic record. */
function interfaceWrite(value: Record<string, unknown>): InterfaceWriteInput {
  const definition = value.definition
  if (
    typeof value.applicationId !== 'string' ||
    (value.environment !== 'development' &&
      value.environment !== 'staging' &&
      value.environment !== 'production') ||
    typeof value.code !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    (value.method !== 'GET' &&
      value.method !== 'POST' &&
      value.method !== 'PUT' &&
      value.method !== 'PATCH' &&
      value.method !== 'DELETE') ||
    typeof value.path !== 'string' ||
    !definition ||
    typeof definition !== 'object' ||
    Array.isArray(definition) ||
    !('inputs' in definition) ||
    !Array.isArray(definition.inputs) ||
    !('steps' in definition) ||
    !Array.isArray(definition.steps) ||
    !('outputs' in definition) ||
    !Array.isArray(definition.outputs)
  )
    throw new Error('The interface page sent an invalid synthetic write payload')
  return {
    applicationId: value.applicationId,
    environment: value.environment,
    code: value.code,
    name: value.name,
    description: value.description,
    method: value.method,
    path: value.path,
    definition: definition as InterfaceDefinition,
    ...(typeof value.version === 'number' ? { version: value.version } : {})
  }
}

async function mockApi(page: Page, optionsDelayMs = 0): Promise<MockState> {
  const state: MockState = {
    rows: initialRows(),
    writes: [],
    unexpected: [],
    errors: [],
    testRuns: 0
  }
  page.on('pageerror', (error) => state.errors.push(error.message))
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const reply = async (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) })
    const body = (): Record<string, unknown> => {
      const value: unknown = request.postDataJSON()
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected JSON object')
      return value as Record<string, unknown>
    }
    if (url.pathname === '/api/auth/session' && method === 'GET') {
      await reply({
        user: {
          id: '77777777-7777-4777-8777-777777777777',
          name: '合成管理员',
          email: 'admin@example.test',
          role: 'admin',
          tenantId: '88888888-8888-4888-8888-888888888888'
        },
        csrfToken: 'synthetic-interface-ui',
        permissions: [
          'BffApplication:View',
          'BffInterface:View',
          'BffInterface:Add',
          'BffInterface:Edit',
          'BffInterface:Validate',
          'BffInterface:Test',
          'BffInterface:TestWrite',
          'BffInterface:Delete'
        ],
        menu: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            parentId: null,
            path: '/interfaces',
            name: 'BffInterfaces',
            component: '/bff/interfaces/index',
            type: 'menu',
            sort: 1,
            meta: { title: '接口编排', icon: 'ri:flow-chart', isEnable: true }
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
    if (url.pathname === '/api/interfaces/options' && method === 'GET') {
      if (optionsDelayMs) await new Promise((resolve) => setTimeout(resolve, optionsDelayMs))
      await reply({
        applications: [application],
        environments: [
          { label: '开发', value: 'development' },
          { label: '预发布', value: 'staging' },
          { label: '生产', value: 'production' }
        ],
        upstreams: [
          {
            id: orderUpstreamId,
            applicationId,
            environment: 'development',
            code: 'order-service',
            name: '订单服务',
            status: 'active',
            configVersion: 1,
            authType: 'none',
            credentialConfigured: false
          },
          {
            id: detailUpstreamId,
            applicationId,
            environment: 'development',
            code: 'detail-service',
            name: '明细服务',
            status: 'active',
            configVersion: 2,
            authType: 'none',
            credentialConfigured: false
          }
        ],
        networkPolicyConfigured: true,
        writeTestsConfigured: true
      })
      return
    }
    if (url.pathname === '/api/interfaces' && method === 'GET') {
      const name = (url.searchParams.get('name') || '').toLowerCase()
      const selected = state.rows.filter(
        (item) =>
          (!name || `${item.name} ${item.code}`.toLowerCase().includes(name)) &&
          (!url.searchParams.get('applicationId') ||
            item.applicationId === url.searchParams.get('applicationId')) &&
          (!url.searchParams.get('environment') ||
            item.environment === url.searchParams.get('environment')) &&
          (!url.searchParams.get('validationStatus') ||
            item.validationStatus === url.searchParams.get('validationStatus')) &&
          (!url.searchParams.get('recordId') || item.id === url.searchParams.get('recordId'))
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
          valid: state.rows.filter((row) => row.validationStatus === 'valid').length,
          unvalidated: state.rows.filter((row) => row.validationStatus === 'unvalidated').length,
          tested: state.rows.filter((row) => row.lastTestStatus === 'passed').length
        }
      })
      return
    }
    if (url.pathname === '/api/interfaces' && method === 'POST') {
      const payload = body()
      const input = interfaceWrite(payload)
      state.writes.push({ method, path: url.pathname, body: payload })
      const created: InterfaceRecord = {
        ...input,
        id: createdId,
        application,
        version: 1,
        validationStatus: 'unvalidated',
        validatedVersion: null,
        validationIssues: [],
        lastValidatedAt: null,
        lastTestStatus: 'not_tested',
        lastTestVersion: null,
        lastTestAt: null,
        createdAt: timestamp,
        updatedAt: timestamp
      }
      state.rows.unshift(created)
      await reply(created, 201)
      return
    }
    const editing = state.rows.find((row) => url.pathname === `/api/interfaces/${row.id}`)
    if (editing && method === 'PUT') {
      const payload = body()
      const input = interfaceWrite(payload)
      state.writes.push({ method, path: url.pathname, body: payload })
      const current = editing
      const updated: InterfaceRecord = {
        ...current,
        ...input,
        version: current.version + 1,
        validationStatus: 'unvalidated',
        validatedVersion: null,
        validationIssues: [],
        lastValidatedAt: null,
        lastTestStatus: 'stale',
        lastTestVersion: null,
        lastTestAt: null
      }
      state.rows = state.rows.map((row) => (row.id === current.id ? updated : row))
      await reply(updated)
      return
    }
    if (url.pathname === `/api/interfaces/${createdId}/validate` && method === 'POST') {
      const input = body()
      state.writes.push({ method, path: url.pathname, body: input })
      const current = state.rows.find((row) => row.id === createdId)
      if (!current) throw new Error('Synthetic created interface missing')
      const validated: InterfaceRecord = {
        ...current,
        validationStatus: 'valid',
        validatedVersion: current.version,
        validationIssues: [],
        lastValidatedAt: timestamp
      }
      state.rows = state.rows.map((row) => (row.id === createdId ? validated : row))
      await reply(validated)
      return
    }
    if (url.pathname === `/api/interfaces/${createdId}/tests` && method === 'POST') {
      const input = body()
      state.writes.push({ method, path: url.pathname, body: input })
      state.testRuns += 1
      const current = state.rows.find((row) => row.id === createdId)
      if (!current) throw new Error('Synthetic created interface missing')
      if (state.testRuns === 1) {
        await reply({
          interfaceId: createdId,
          version: current.version,
          passed: false,
          stale: true,
          output: {},
          steps: [],
          durationMs: 0,
          message: '草稿配置已变化'
        })
      } else {
        state.rows = state.rows.map((row) =>
          row.id === createdId
            ? {
                ...row,
                lastTestStatus: 'passed',
                lastTestVersion: row.version,
                lastTestAt: timestamp
              }
            : row
        )
        await reply({
          interfaceId: createdId,
          version: current.version,
          passed: true,
          stale: false,
          output: { status: 'ready', total: 2 },
          steps: [
            {
              key: 'fetchOrder',
              name: '查询订单',
              status: 'passed',
              statusCode: 200,
              durationMs: 36,
              message: '连接正常'
            },
            {
              key: 'fetchItems',
              name: '查询明细',
              status: 'passed',
              statusCode: 200,
              durationMs: 42,
              message: '连接正常'
            }
          ],
          durationMs: 78,
          message: '已完成两步测试'
        })
      }
      return
    }
    state.unexpected.push(`${method} ${url.pathname}`)
    await reply({ code: 'UNEXPECTED', message: '未配置的测试接口' }, 404)
  })
  return state
}

test('editing an existing interface opens before upstream options finish loading', async ({
  page
}) => {
  const state = await mockApi(page, 4_000)
  await page.goto('/interfaces')
  const row = page.getByRole('row').filter({ hasText: '验收示例：库存核对接口' })
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: '编辑接口草稿' }).click()
  const dialog = page.getByRole('dialog', { name: '编辑接口草稿' })
  await expect(dialog).toBeVisible({ timeout: 1_500 })
  await expect(dialog.getByText('正在加载应用与上游选项，当前草稿可先查看。')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '保存草稿' })).toBeDisabled()
  await expect(dialog.getByText('正在加载应用与上游选项，当前草稿可先查看。')).toHaveCount(0, {
    timeout: 6_000
  })
  expect(state.writes).toHaveLength(0)
  expect(state.errors).toEqual([])
})

test('mapping choices use configured dictionary labels and omit disabled items', async ({
  page
}) => {
  const state = await mockApi(page)
  const snapshot = dictionarySnapshot()
  for (const item of snapshot.items) {
    if (item.dictTypeTable.code !== 'bffInterfaceBindingSource') continue
    if (item.value === 'step') item.label = '前序结果（字典验收）'
    if (item.value === 'literal') item.status = '2'
  }
  await page.route('**/api/control/dictionaries*', (route) => route.fulfill({ json: snapshot }))
  await page.goto('/interfaces')
  await page
    .getByRole('row')
    .filter({ hasText: '验收示例：订单查询接口' })
    .getByRole('button', { name: '编辑接口草稿' })
    .click()
  const editor = page.getByRole('dialog', { name: '编辑接口草稿' })
  await editor.getByRole('tab', { name: /输出映射/ }).click()
  await editor.getByLabel('对调用方公开的输出第 1 项来源').click()
  await expect(
    page.getByRole('option', { name: '前序结果（字典验收）', exact: true })
  ).toBeVisible()
  await expect(page.getByRole('option', { name: '固定值', exact: true })).toHaveCount(0)
  await page.getByRole('option', { name: '前序结果（字典验收）', exact: true }).click()
  await editor.getByRole('button', { name: '保存草稿' }).click()
  await expect(editor).toHaveCount(0)
  expect((state.writes[0].body.definition as InterfaceDefinition).outputs[0].source).toBe('step')
  expect(state.errors).toEqual([])
})

test('two two-step drafts support filtering, empty result and recovery', async ({ page }) => {
  const state = await mockApi(page)
  await page.goto('/interfaces')
  await expect(page.getByRole('heading', { name: '接口编排' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：订单查询接口' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存核对接口' })).toBeVisible()
  const keyword = page.getByPlaceholder('搜索名称或编码')
  await keyword.fill('订单查询')
  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：订单查询接口' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存核对接口' })).toHaveCount(0)
  await keyword.fill('不存在的接口')
  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByText('暂无符合条件的接口草稿')).toBeVisible()
  await page.getByRole('button', { name: '重置' }).click()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存核对接口' })).toBeVisible()
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('create, edit two steps, validate and test with invalid input and stale response', async ({
  page
}) => {
  test.setTimeout(90_000)
  const state = await mockApi(page)
  await page.goto('/interfaces')
  await expect(page.getByRole('heading', { name: '接口编排' })).toBeVisible()
  await page.getByRole('button', { name: '新增接口草稿' }).click()
  let editor = page.getByRole('dialog', { name: '新增接口草稿' })
  await editor.getByPlaceholder('例如：order-detail').fill('order-audit')
  await editor.getByPlaceholder('例如：订单详情查询').fill('验收示例：订单审核接口')
  await editor.getByRole('tab', { name: /编排步骤/ }).click()
  const firstStep = editor.getByTestId('interface-step-1')
  await firstStep.getByLabel('步骤 1 上游服务').click()
  await page.getByRole('option', { name: /订单服务/ }).click()
  await editor.getByRole('button', { name: '保存草稿' }).click()
  await expect(editor).toHaveCount(0)
  expect(
    (
      state.writes.find((item) => item.method === 'POST' && item.path === '/api/interfaces')?.body
        .definition as InterfaceDefinition
    ).steps
  ).toHaveLength(1)

  let row = page.getByRole('row').filter({ hasText: '验收示例：订单审核接口' })
  await row.getByRole('button', { name: '编辑接口草稿' }).click()
  editor = page.getByRole('dialog', { name: '编辑接口草稿' })
  await editor.getByRole('tab', { name: /编排步骤/ }).click()
  await editor.getByRole('button', { name: '新增步骤' }).click()
  const secondStep = editor.getByTestId('interface-step-2')
  await secondStep.getByLabel('步骤 2 键').fill('fetchItems')
  await secondStep.getByLabel('步骤 2 名称').fill('查询明细')
  await secondStep.getByLabel('步骤 2 上游服务').click()
  await page.getByRole('option', { name: /明细服务/ }).click()
  await secondStep.getByLabel('步骤 2 请求方法').click()
  await page.getByRole('option', { name: 'POST' }).click()
  await secondStep.getByLabel('步骤 2 相对路径').fill('/orders/{orderId}/items')
  const pathBindings = secondStep.getByRole('region', { name: '路径参数' })
  await pathBindings.getByRole('button', { name: '新增映射' }).click()
  await pathBindings.getByLabel('路径参数第 1 项变量名').fill('orderId')
  await editor.getByRole('tab', { name: /输出映射/ }).click()
  const outputs = editor.getByRole('region', { name: '对调用方公开的输出' })
  mkdirSync(path.resolve('.artifacts/ui'), { recursive: true })
  await page.screenshot({ path: '.artifacts/ui/interface-output-editor.png' })
  await outputs.getByRole('button', { name: '新增映射' }).click()
  await outputs.getByLabel('对调用方公开的输出第 2 项目标字段').fill('total')
  await outputs.getByLabel('对调用方公开的输出第 2 项来源').click()
  await page.getByRole('option', { name: '前序步骤' }).click()
  await outputs.getByLabel('对调用方公开的输出第 2 项前序步骤').click()
  await page.getByRole('option', { name: /查询明细/ }).click()
  await outputs.getByLabel('对调用方公开的输出第 2 项 JSON Pointer').fill('/total')
  await editor.getByRole('button', { name: '保存草稿' }).click()
  await expect(editor).toHaveCount(0)
  const editBody = state.writes.find(
    (item) => item.method === 'PUT' && item.path === `/api/interfaces/${createdId}`
  )?.body
  expect((editBody?.definition as InterfaceDefinition).steps).toHaveLength(2)
  expect((editBody?.definition as InterfaceDefinition).steps[1]?.method).toBe('POST')

  row = page.getByRole('row').filter({ hasText: '验收示例：订单审核接口' })
  await row.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '验证定义' }).click()
  await expect(row.getByText('已通过')).toBeVisible()
  await row.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '运行测试' }).click()
  const testDialog = page.getByRole('dialog', { name: '接口测试' })
  await expect(testDialog).toBeVisible()
  await testDialog.getByRole('button', { name: '运行测试' }).click()
  expect(state.testRuns).toBe(0)
  await testDialog.getByPlaceholder('输入订单编号').fill('ORD-001')
  await testDialog.getByRole('button', { name: '运行测试' }).click()
  await page.getByRole('button', { name: '确认测试' }).click()
  await expect(
    testDialog.getByText('草稿配置已变化，本次旧测试结果未应用，请重新测试。')
  ).toBeVisible()
  await testDialog.getByRole('button', { name: '运行测试' }).click()
  await page.getByRole('button', { name: '确认测试' }).click()
  await expect(testDialog.getByText('已完成两步测试')).toBeVisible()
  await expect(testDialog.getByText('ready')).toBeVisible()
  await expect(testDialog.getByText('总耗时 78 毫秒')).toBeVisible()
  await expect(page.locator('.el-overlay-message-box')).toHaveCount(0)
  await testDialog.getByText('ready').scrollIntoViewIfNeeded()
  const screenshotPath = path.resolve('.artifacts/ui/interface-test-success.png')
  mkdirSync(path.dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath })
  expect(state.testRuns).toBe(2)
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})
