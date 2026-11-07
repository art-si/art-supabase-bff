import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { AlertInstance, AlertRule, CallRecord } from '../../src/types/observability'

const testOrigin = process.env.BFF_TEST_ORIGIN || 'http://127.0.0.1:3013'

const appId = '33333333-3333-4333-8333-333333333333'
const interfaceId = '44444444-4444-4444-8444-444444444444'
const now = '2026-11-07T08:30:00Z'
const ruleId = '55555555-5555-4555-8555-555555555555'
const secondRuleId = '66666666-6666-4666-8666-666666666666'
const alertId = '77777777-7777-4777-8777-777777777777'
const secondAlertId = '88888888-8888-4888-8888-888888888888'
const app = { id: appId, code: 'orders', name: '合成订单应用', enabled: true }
const environments = [
  { value: 'development', label: '开发' },
  { value: 'production', label: '生产' }
]
const calls: CallRecord[] = [
  {
    requestId: 'req-success-001',
    applicationId: appId,
    applicationName: app.name,
    environment: 'development',
    interfaceId,
    interfaceName: '库存查询',
    versionNumber: 2,
    method: 'GET',
    pathTemplate: '/inventory/{sku}',
    startedAt: now,
    finishedAt: now,
    durationMs: 84,
    status: 'succeeded',
    httpStatus: 200,
    errorCode: null,
    errorClass: null,
    steps: [
      {
        key: 'inventory',
        status: 'passed',
        code: null,
        errorClass: null,
        statusCode: 200,
        durationMs: 76
      }
    ]
  },
  {
    requestId: 'req-timeout-002',
    applicationId: appId,
    applicationName: app.name,
    environment: 'production',
    interfaceId,
    interfaceName: '订单提交',
    versionNumber: 4,
    method: 'POST',
    pathTemplate: '/orders',
    startedAt: now,
    finishedAt: now,
    durationMs: 30000,
    status: 'unknown',
    httpStatus: null,
    errorCode: 'UPSTREAM_TIMEOUT',
    errorClass: 'timeout',
    steps: [
      {
        key: 'submit',
        status: 'failed',
        code: 'UPSTREAM_TIMEOUT',
        errorClass: 'timeout',
        statusCode: null,
        durationMs: 30000
      }
    ]
  }
]
function rule(id: string, name: string, enabled = true): AlertRule {
  return {
    id,
    applicationId: appId,
    applicationName: app.name,
    environment: 'production',
    interfaceId,
    interfaceName: '订单提交',
    name,
    metric: 'unknown_count',
    windowMinutes: 15,
    threshold: 1,
    minCalls: 1,
    severity: 'critical',
    enabled,
    quietMinutes: 15,
    version: 1,
    archivedAt: null,
    lastEvaluatedAt: null,
    createdAt: now,
    updatedAt: now
  }
}
function instance(id: string, source: AlertRule, state: AlertInstance['state']): AlertInstance {
  return {
    id,
    ruleId: source.id,
    ruleName: source.name,
    applicationId: appId,
    applicationName: app.name,
    environment: 'production',
    interfaceId,
    interfaceName: '订单提交',
    metric: source.metric,
    severity: source.severity,
    state,
    observedValue: 1,
    knownCalls: 2,
    failedCalls: 0,
    unknownCalls: 1,
    windowStartedAt: now,
    windowEndedAt: now,
    openedAt: now,
    acknowledgedAt: state === 'acknowledged' ? now : null,
    acknowledgedByName: state === 'acknowledged' ? '合成管理员' : null,
    recoveredAt: state === 'recovered' ? now : null,
    closedAt: null,
    closedReason: null,
    version: 1,
    lastObservedAt: now
  }
}
interface MockState {
  rules: AlertRule[]
  alerts: AlertInstance[]
  writes: string[]
  unexpected: string[]
  errors: string[]
  evaluationCount: number
}
async function mockApi(page: Page): Promise<MockState> {
  const state: MockState = {
    rules: [rule(ruleId, '生产订单结果未知'), rule(secondRuleId, '备用超时监测', false)],
    alerts: [
      instance(alertId, rule(ruleId, '生产订单结果未知'), 'open'),
      instance(secondAlertId, rule(secondRuleId, '备用超时监测'), 'recovered')
    ],
    writes: [],
    unexpected: [],
    errors: [],
    evaluationCount: 0
  }
  page.on('pageerror', (error) => state.errors.push(error.message))
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const method = request.method()
    const reply = async (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    const body = (): Record<string, unknown> => {
      const value: unknown = request.postDataJSON()
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected object')
      return value as Record<string, unknown>
    }
    if (pathname === '/api/auth/session') {
      await reply({
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          name: '合成管理员',
          email: 'admin@example.test',
          role: 'admin',
          tenantId: '22222222-2222-4222-8222-222222222222'
        },
        csrfToken: 'synthetic-browser-test',
        permissions: [
          'BffCall:View',
          'BffAlert:View',
          'BffAlertRule:View',
          'BffAlert:Add',
          'BffAlert:Edit',
          'BffAlert:ChangeStatus',
          'BffAlert:Archive',
          'BffAlert:Evaluate',
          'BffAlert:Acknowledge'
        ],
        menu: [
          {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            parentId: null,
            path: '/observability',
            name: 'BffObservability',
            component: '/index/index',
            type: 'folder',
            sort: 1,
            meta: { title: '运行观测', icon: 'ri:line-chart-line', isEnable: true },
            children: [
              {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                parentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                path: '/calls',
                name: 'BffCalls',
                component: '/bff/calls/index',
                type: 'menu',
                sort: 1,
                meta: { title: '调用日志', icon: 'ri:file-search-line', isEnable: true }
              },
              {
                id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                parentId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                path: '/alerts',
                name: 'BffAlerts',
                component: '',
                type: 'folder',
                sort: 2,
                meta: { title: '告警中心', icon: 'ri:alarm-warning-line', isEnable: true },
                children: [
                  {
                    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                    parentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                    path: '/alerts/rules',
                    name: 'BffAlertRules',
                    component: '/bff/alerts/rules/index',
                    type: 'menu',
                    sort: 1,
                    meta: { title: '告警规则', icon: 'ri:settings-4-line', isEnable: true }
                  },
                  {
                    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    parentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
                    path: '/alerts/instances',
                    name: 'BffAlertInstances',
                    component: '/bff/alerts/index',
                    type: 'menu',
                    sort: 2,
                    meta: { title: '告警事件', icon: 'ri:notification-3-line', isEnable: true }
                  }
                ]
              }
            ]
          }
        ]
      })
      return
    }
    if (pathname === '/api/control/dictionaries') {
      await reply({ revision: 1, types: [], items: [] })
      return
    }
    if (pathname === '/api/control/table-columns') {
      await reply({ mode: 'frontend', profile: null, columns: [] })
      return
    }
    if (pathname === '/api/calls/options') {
      await reply({
        applications: [app],
        environments,
        interfaces: [
          {
            id: interfaceId,
            applicationId: appId,
            name: '订单提交',
            code: 'submit',
            environment: 'production'
          }
        ],
        statuses: [
          { value: 'succeeded', label: '成功' },
          { value: 'unknown', label: '结果未知' }
        ],
        errorClasses: [{ value: 'timeout', label: '超时' }]
      })
      return
    }
    if (pathname === '/api/calls' && method === 'GET') {
      const selected = calls.filter(
        (row) =>
          (!url.searchParams.get('interfaceId') ||
            row.interfaceId === url.searchParams.get('interfaceId')) &&
          (!url.searchParams.get('status') || row.status === url.searchParams.get('status'))
      )
      await reply({
        records: selected,
        total: selected.length,
        current: 1,
        size: 20,
        summary: {
          total: selected.length,
          running: 0,
          succeeded: selected.filter((row) => row.status === 'succeeded').length,
          failed: 0,
          unknown: selected.filter((row) => row.status === 'unknown').length,
          timeout: 1
        }
      })
      return
    }
    if (pathname.startsWith('/api/calls/') && method === 'GET') {
      await reply(
        calls.find(
          (row) => row.requestId === decodeURIComponent(pathname.slice('/api/calls/'.length))
        ) ?? {},
        200
      )
      return
    }
    if (pathname === '/api/alerts/options') {
      await reply({
        applications: [app],
        environments,
        interfaces: [
          {
            id: interfaceId,
            applicationId: appId,
            name: '订单提交',
            code: 'submit',
            environment: 'production'
          }
        ],
        metrics: [
          { value: 'failure_count', label: '失败次数' },
          { value: 'failure_rate', label: '失败率' },
          { value: 'timeout_count', label: '超时次数' },
          { value: 'unknown_count', label: '未知结果数' }
        ],
        severities: [
          { value: 'warning', label: '警告' },
          { value: 'critical', label: '严重' }
        ],
        statuses: [
          { value: 'open', label: '待处理' },
          { value: 'acknowledged', label: '已确认' },
          { value: 'recovered', label: '已恢复' },
          { value: 'closed', label: '已关闭' }
        ],
        errorClasses: []
      })
      return
    }
    if (pathname === '/api/alerts/rules' && method === 'GET') {
      const archived = url.searchParams.get('archived') === 'true'
      const selected = state.rules.filter((row) => Boolean(row.archivedAt) === archived)
      await reply({
        records: selected,
        total: selected.length,
        current: 1,
        size: 20,
        summary: {
          total: selected.length,
          enabled: selected.filter((row) => row.enabled).length,
          disabled: selected.filter((row) => !row.enabled).length,
          archived: selected.filter((row) => row.archivedAt).length
        }
      })
      return
    }
    if (pathname === '/api/alerts/rules' && method === 'POST') {
      const input = body()
      state.writes.push('create')
      state.rules.unshift({
        ...rule('99999999-9999-4999-8999-999999999999', String(input.name), Boolean(input.enabled)),
        ...input,
        version: 1
      } as AlertRule)
      await reply(state.rules[0], 201)
      return
    }
    const ruleMatch = pathname.match(
      /^\/api\/alerts\/rules\/([^/]+)(?:\/(status|archive|evaluate))?$/
    )
    if (ruleMatch && method !== 'GET') {
      const current = state.rules.find((row) => row.id === ruleMatch[1])
      if (!current) {
        await reply({ message: '规则不存在' }, 404)
        return
      }
      const action = ruleMatch[2] || 'update'
      state.writes.push(action)
      if (action === 'update') Object.assign(current, body(), { version: current.version + 1 })
      if (action === 'status')
        Object.assign(current, { enabled: Boolean(body().enabled), version: current.version + 1 })
      if (action === 'archive')
        Object.assign(current, { archivedAt: now, enabled: false, version: current.version + 1 })
      if (action === 'evaluate') {
        state.evaluationCount++
        const alert = state.alerts.find((row) => row.ruleId === current.id)
        if (alert && state.evaluationCount > 1)
          Object.assign(alert, { state: 'recovered', recoveredAt: now, version: alert.version + 1 })
        await reply({
          evaluated: 1,
          opened: state.evaluationCount === 1 ? 1 : 0,
          updated: 0,
          recovered: state.evaluationCount > 1 ? 1 : 0,
          closed: 0,
          expired: 0,
          clearedReplay: 0,
          instanceId: alert?.id
        })
        return
      }
      await reply(current)
      return
    }
    if (pathname === '/api/alerts' && method === 'GET') {
      const selected = state.alerts.filter(
        (row) => !url.searchParams.get('state') || row.state === url.searchParams.get('state')
      )
      await reply({
        records: selected,
        total: selected.length,
        current: 1,
        size: 20,
        summary: {
          total: selected.length,
          open: selected.filter((row) => row.state === 'open').length,
          acknowledged: selected.filter((row) => row.state === 'acknowledged').length,
          recovered: selected.filter((row) => row.state === 'recovered').length,
          closed: 0
        }
      })
      return
    }
    const alertMatch = pathname.match(/^\/api\/alerts\/([^/]+)(?:\/(ack))?$/)
    if (alertMatch) {
      const alert = state.alerts.find((row) => row.id === alertMatch[1])
      if (!alert) {
        await reply({ message: '事件不存在' }, 404)
        return
      }
      if (alertMatch[2] === 'ack') {
        state.writes.push('ack')
        Object.assign(alert, {
          state: 'acknowledged',
          acknowledgedAt: now,
          acknowledgedByName: '合成管理员',
          version: alert.version + 1
        })
      }
      await reply(alert)
      return
    }
    state.unexpected.push(`${method} ${pathname}`)
    await reply({ message: 'Unexpected mock API' }, 500)
  })
  return state
}

async function setVisualState(
  page: Page,
  width: number,
  height: number,
  dark: boolean
): Promise<void> {
  await page.setViewportSize({ width, height })
  await page.evaluate((isDark) => {
    document.documentElement.classList.toggle('dark', isDark)
    document.documentElement.dataset.boxMode = isDark ? 'shadow-mode' : 'border-mode'
  }, dark)
  await page.waitForTimeout(350)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true)
}

async function navigateAlertPage(page: Page, label: '告警规则' | '告警事件'): Promise<void> {
  const root = page.getByRole('menuitem', { name: '运行观测' })
  if (!(await root.isVisible()))
    await page.getByRole('button', { name: '展开或收起侧边菜单' }).click()
  await expect(root).toBeVisible()
  const group = page.getByRole('menuitem', { name: '告警中心' })
  if (!(await group.isVisible())) await root.click()
  await expect(group).toBeVisible()
  const target = page.getByRole('menuitem', { name: label })
  if (!(await target.isVisible())) await group.click()
  await target.click()
}

test('调用日志仅展示安全字段，并完成告警规则与事件生命周期', async ({ page }) => {
  test.setTimeout(120_000)
  const state = await mockApi(page)
  const output = path.resolve('.artifacts/ui/observability')
  mkdirSync(output, { recursive: true })
  await page.goto(`${testOrigin}/calls`)
  await expect(page.getByRole('heading', { name: '调用日志' })).toBeVisible()
  const hintDismiss = page.getByText('知道了')
  if (await hintDismiss.isVisible()) await hintDismiss.click()
  await expect(page.getByText('req-success-001')).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: 'req-timeout-002' })).toBeVisible()
  await page.screenshot({ path: path.join(output, 'calls-light-1440.png') })
  await page
    .getByRole('row')
    .filter({ hasText: 'req-timeout-002' })
    .getByRole('button', { name: '查看调用详情' })
    .click()
  await expect(page.getByText('上游操作可能已经执行')).toBeVisible()
  await expect(
    page.getByRole('dialog', { name: '调用详情' }).getByText('req-timeout-002')
  ).toBeVisible()
  await page.screenshot({ path: path.join(output, 'calls-detail-light-1440.png') })
  expect(await page.locator('body').innerText()).not.toMatch(
    /inputHash|idempotencyHash|cipher|rawParams|rawUrl/i
  )
  await page
    .getByRole('dialog', { name: '调用详情' })
    .getByRole('button', { name: '关闭抽屉' })
    .click()
  await page
    .locator('.el-switch')
    .filter({ has: page.getByRole('switch', { name: '进入专注模式' }) })
    .click()
  await expect(page.getByRole('heading', { name: '调用日志' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '调用日志' })).toBeVisible()
  await setVisualState(page, 1280, 800, true)
  await page.screenshot({ path: path.join(output, 'calls-dark-1280.png') })
  await setVisualState(page, 390, 844, false)
  await page.screenshot({ path: path.join(output, 'calls-mobile-390.png') })
  await setVisualState(page, 1440, 900, false)

  await navigateAlertPage(page, '告警规则')
  await expect(page.getByRole('heading', { name: '告警规则' })).toBeVisible()
  await expect(page.getByText('生产订单结果未知')).toBeVisible()
  await expect(page.getByText('备用超时监测')).toBeVisible()
  await page.getByRole('button', { name: '创建告警规则' }).click()
  const dialog = page.getByRole('dialog', { name: '创建告警规则' })
  await expect(dialog.getByText('失败率只用已确认完成')).toHaveCount(0)
  await dialog.getByRole('textbox', { name: '规则名称' }).fill('生产接口失败率')
  await dialog.getByRole('button', { name: '创建规则' }).click()
  await expect.poll(() => state.writes).toContain('create')
  await expect(dialog).toBeHidden()
  await expect(page.getByText('生产接口失败率')).toBeVisible()
  const created = page.getByRole('row').filter({ hasText: '生产接口失败率' })
  await created.getByRole('button', { name: '编辑告警规则' }).click()
  const edit = page.getByRole('dialog', { name: '编辑告警规则' })
  await edit.getByRole('textbox', { name: '规则名称' }).fill('生产接口失败率监测')
  await page.waitForTimeout(350)
  await page.screenshot({ path: path.join(output, 'rules-editor-light-1440.png') })
  await edit.getByRole('button', { name: '保存规则' }).click()
  await expect.poll(() => state.writes).toContain('update')
  await expect(edit).toBeHidden()
  await page.screenshot({ path: path.join(output, 'rules-light-1440.png') })
  await setVisualState(page, 1280, 800, true)
  await page.screenshot({ path: path.join(output, 'rules-dark-1280.png') })
  await setVisualState(page, 390, 844, false)
  await page.screenshot({ path: path.join(output, 'rules-mobile-390.png') })
  await setVisualState(page, 1440, 900, false)
  await page
    .locator('.el-switch')
    .filter({ has: page.getByRole('switch', { name: '进入专注模式' }) })
    .click()
  await expect(page.getByRole('heading', { name: '告警规则' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '告警规则' })).toBeVisible()
  const original = page.getByRole('row').filter({ hasText: '生产订单结果未知' })
  await original.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '立即评估' }).click()
  await expect.poll(() => state.writes).toContain('evaluate')

  await navigateAlertPage(page, '告警事件')
  await expect(page.getByRole('heading', { name: '告警事件' })).toBeVisible()
  await expect(page.getByText('生产订单结果未知')).toBeVisible()
  await expect(page.getByText('备用超时监测')).toBeVisible()
  await page
    .getByRole('row')
    .filter({ hasText: '生产订单结果未知' })
    .getByRole('button', { name: '查看告警详情' })
    .click()
  await page.getByRole('button', { name: '确认接手' }).click()
  await page.getByRole('button', { name: '确认接手' }).last().click()
  await expect.poll(() => state.writes).toContain('ack')
  await expect(page.getByText('已确认仅表示有人接手')).toBeVisible()
  await expect(page.locator('.el-message')).toHaveCount(0)
  await page.screenshot({ path: path.join(output, 'alerts-ack-light-1440.png') })
  await page
    .getByRole('dialog', { name: '告警详情' })
    .getByRole('button', { name: '关闭抽屉' })
    .click()
  await navigateAlertPage(page, '告警规则')
  await page
    .getByRole('row')
    .filter({ hasText: '生产订单结果未知' })
    .getByRole('button', { name: '更多操作' })
    .hover()
  await page.getByRole('menuitem', { name: '立即评估' }).click()
  await navigateAlertPage(page, '告警事件')
  await expect(
    page.getByRole('row').filter({ hasText: '生产订单结果未知' }).getByText('已恢复')
  ).toBeVisible()
  await navigateAlertPage(page, '告警规则')
  const managedRule = page.getByRole('row').filter({ hasText: '生产接口失败率监测' })
  await managedRule.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '启用规则' }).click()
  await page.getByRole('button', { name: '确认启用' }).click()
  await expect.poll(() => state.writes).toContain('status')
  await expect(managedRule.getByText('已启用')).toBeVisible()
  await managedRule.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '停用规则' }).click()
  await page.getByRole('button', { name: '确认停用' }).click()
  await expect(managedRule.getByText('已停用')).toBeVisible()
  await managedRule.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '归档规则' }).click()
  await page.getByRole('button', { name: '确认归档' }).click()
  await expect.poll(() => state.writes).toContain('archive')
  await expect(managedRule).toHaveCount(0)
  await page.getByRole('combobox', { name: '归档状态' }).click()
  await page.getByRole('option', { name: '归档历史' }).click()
  await page.getByRole('button', { name: '查询' }).click()
  await expect(
    page.getByRole('row').filter({ hasText: '生产接口失败率监测' }).getByText('已归档')
  ).toBeVisible()
  await navigateAlertPage(page, '告警事件')
  await page
    .locator('.el-switch')
    .filter({ has: page.getByRole('switch', { name: '进入专注模式' }) })
    .click()
  await expect(page.getByRole('heading', { name: '告警事件' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '告警事件' })).toBeVisible()
  await setVisualState(page, 1280, 800, true)
  await expect(page.locator('.el-message')).toHaveCount(0)
  await page.screenshot({ path: path.join(output, 'alerts-dark-1280.png') })
  await setVisualState(page, 390, 844, false)
  await page.screenshot({ path: path.join(output, 'alerts-mobile-390.png') })
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('调用日志加载失败后可重试，长名称保持可读且页面不横向溢出', async ({ page }) => {
  const state = await mockApi(page)
  const output = path.resolve('.artifacts/ui/observability')
  mkdirSync(output, { recursive: true })
  const longName = '验收示例：跨区域订单提交与库存锁定一致性校验接口'
  let firstRead = true
  await page.route(/^https?:\/\/[^/]+\/api\/calls\?/, async (route) => {
    if (firstRead) {
      firstRead = false
      await new Promise((resolve) => setTimeout(resolve, 2500))
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'TEST_UNAVAILABLE', message: '验收模拟：调用日志暂不可用' })
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        records: [{ ...calls[1], interfaceName: longName }, calls[0]],
        total: 2,
        current: 1,
        size: 20,
        summary: { total: 2, running: 0, succeeded: 1, failed: 0, unknown: 1, timeout: 1 }
      })
    })
  })
  await page.goto(`${testOrigin}/calls`)
  await expect(page.getByRole('heading', { name: '调用日志' })).toBeVisible()
  const hintDismiss = page.getByText('知道了')
  if (await hintDismiss.isVisible()) await hintDismiss.click()
  await page.screenshot({ path: path.join(output, 'calls-loading-light-1440.png') })
  await expect(page.getByText('数据加载失败')).toBeVisible()
  await page.screenshot({ path: path.join(output, 'calls-error-light-1440.png') })
  await page.getByRole('button', { name: '重新加载' }).click()
  await expect(page.getByTitle(longName)).toBeVisible()
  await setVisualState(page, 390, 844, false)
  await expect(page.getByTitle(longName)).toHaveAttribute('title', longName)
  await page.screenshot({ path: path.join(output, 'calls-long-mobile-390.png') })
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})
