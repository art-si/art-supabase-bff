import { checkPaginationLayouts } from '../fixtures/pagination-layout'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type {
  ReleaseEvent,
  ReleaseHistory,
  ReleaseRecord,
  ReleaseVersion
} from '../../src/types/release'
import type { InterfaceDefinition } from '../../src/types/interface'

const appId = '11111111-1111-4111-8111-111111111111'
const firstId = '22222222-2222-4222-8222-222222222222'
const secondId = '33333333-3333-4333-8333-333333333333'
const application = { id: appId, code: 'demo-ops', name: '合成运营应用', enabled: true }
const timestamp = '2026-11-07T08:30:00Z'
const definition: InterfaceDefinition = {
  inputs: [{ key: 'orderId', label: '订单编号', location: 'path', type: 'string', required: true }],
  steps: [
    {
      key: 'fetchOrder',
      name: '查询订单',
      upstreamId: '44444444-4444-4444-8444-444444444444',
      configVersion: 1,
      method: 'GET',
      path: '/orders/{orderId}',
      pathParams: [
        {
          target: 'orderId',
          source: 'input',
          inputKey: 'orderId',
          stepKey: '',
          pointer: '',
          literalType: 'string',
          literalValue: ''
        }
      ],
      query: [],
      body: []
    }
  ],
  outputs: [
    {
      target: 'status',
      source: 'step',
      inputKey: '',
      stepKey: 'fetchOrder',
      pointer: '/status',
      literalType: 'string',
      literalValue: ''
    }
  ]
}

function initialRecords(): ReleaseRecord[] {
  return [
    {
      interfaceId: firstId,
      applicationId: appId,
      application,
      environment: 'development',
      code: 'order-status',
      name: '验收示例：订单状态接口',
      description: '仅用于模拟发布流程',
      draftVersion: 1,
      draftMethod: 'GET',
      draftPath: '/orders/{orderId}',
      validationStatus: 'valid',
      lastTestStatus: 'passed',
      lastTestVersion: 1,
      versionCount: 0,
      deployment: null
    },
    {
      interfaceId: secondId,
      applicationId: appId,
      application,
      environment: 'development',
      code: 'stock-audit',
      name: '验收示例：库存核对接口',
      description: '仅用于模拟就绪阻断',
      draftVersion: 1,
      draftMethod: 'GET',
      draftPath: '/stocks/{orderId}',
      validationStatus: 'unvalidated',
      lastTestStatus: 'not_tested',
      lastTestVersion: null,
      versionCount: 0,
      deployment: null
    }
  ]
}

interface State {
  records: ReleaseRecord[]
  versions: ReleaseVersion[]
  events: ReleaseEvent[]
  writes: Array<{ path: string; body: Record<string, unknown> }>
  unexpected: string[]
  errors: string[]
  failNextStatus: boolean
}

function history(
  state: State,
  interfaceId: string,
  versionPage = 1,
  eventPage = 1,
  size = 20
): ReleaseHistory {
  const record = state.records.find((item) => item.interfaceId === interfaceId)
  if (!record) throw new Error('Synthetic release record missing')
  const versions = interfaceId === firstId ? state.versions : []
  const events = interfaceId === firstId ? state.events : []
  return {
    record,
    versions: versions.slice((versionPage - 1) * size, versionPage * size),
    events: events.slice((eventPage - 1) * size, eventPage * size),
    versionsTotal: versions.length,
    eventsTotal: events.length,
    versionPage,
    eventPage,
    size
  }
}

async function mockApi(page: Page): Promise<State> {
  const state: State = {
    records: initialRecords(),
    versions: [],
    events: [],
    writes: [],
    unexpected: [],
    errors: [],
    failNextStatus: false
  }
  page.on('pageerror', (error) => state.errors.push(error.message))
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    const reply = async (value: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    const body = (): Record<string, unknown> => {
      const value: unknown = request.postDataJSON()
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected JSON object')
      return value as Record<string, unknown>
    }
    if (url.pathname === '/api/auth/session' && method === 'GET') {
      await reply({
        user: {
          id: '55555555-5555-4555-8555-555555555555',
          name: '合成管理员',
          email: 'admin@example.test',
          role: 'admin',
          tenantId: '66666666-6666-4666-8666-666666666666'
        },
        csrfToken: 'synthetic-release-ui',
        permissions: [
          'BffApplication:View',
          'BffRelease:View',
          'BffRelease:Publish',
          'BffRelease:Rollback',
          'BffRelease:ChangeStatus'
        ],
        menu: [
          {
            id: '77777777-7777-4777-8777-777777777777',
            parentId: null,
            path: '/releases',
            name: 'BffReleases',
            component: '/bff/releases/index',
            type: 'menu',
            sort: 1,
            meta: { title: '版本发布', icon: 'ri:git-commit-line', isEnable: true }
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
    if (url.pathname === '/api/releases/options' && method === 'GET') {
      await reply({
        applications: [application],
        environments: [
          { label: '开发', value: 'development' },
          { label: '预发布', value: 'staging' },
          { label: '生产', value: 'production' }
        ]
      })
      return
    }
    if (url.pathname === '/api/releases' && method === 'GET') {
      const name = (url.searchParams.get('name') || '').toLowerCase()
      const selected = state.records.filter(
        (item) =>
          (!name || `${item.name} ${item.code}`.toLowerCase().includes(name)) &&
          (!url.searchParams.get('applicationId') ||
            item.applicationId === url.searchParams.get('applicationId')) &&
          (!url.searchParams.get('environment') ||
            item.environment === url.searchParams.get('environment')) &&
          (!url.searchParams.get('status') ||
            (item.deployment
              ? item.deployment.enabled
                ? 'enabled'
                : 'disabled'
              : 'unpublished') === url.searchParams.get('status')) &&
          (!url.searchParams.get('recordId') ||
            item.interfaceId === url.searchParams.get('recordId'))
      )
      const current = Number(url.searchParams.get('current')) || 1
      const size = Number(url.searchParams.get('size')) || 20
      await reply({
        records: selected.slice((current - 1) * size, current * size),
        total: selected.length,
        current,
        size,
        summary: {
          total: state.records.length,
          enabled: state.records.filter((item) => item.deployment?.enabled).length,
          disabled: state.records.filter((item) => item.deployment && !item.deployment.enabled)
            .length,
          unpublished: state.records.filter((item) => !item.deployment).length
        }
      })
      return
    }
    const routeMatch =
      /^\/api\/releases\/([^/]+)\/(history|readiness|publish|rollback|status)$/.exec(url.pathname)
    if (routeMatch) {
      const [, interfaceId, operation] = routeMatch
      if (operation === 'history' && method === 'GET') {
        await reply(
          history(
            state,
            interfaceId,
            Number(url.searchParams.get('versionPage')) || 1,
            Number(url.searchParams.get('eventPage')) || 1,
            Number(url.searchParams.get('size')) || 20
          )
        )
        return
      }
      if (operation === 'readiness' && method === 'GET') {
        const purpose = url.searchParams.get('purpose')
        const selected = state.records.find((item) => item.interfaceId === interfaceId)
        const ready = Boolean(
          selected && (purpose !== 'publish' || selected.validationStatus === 'valid')
        )
        await reply({
          ready,
          checks: [
            {
              key: 'validation',
              label: '结构与测试',
              passed: ready,
              message: ready ? '已验证并在受控环境测试通过' : '请先验证定义并完成测试'
            },
            {
              key: 'upstream',
              label: '上游配置',
              passed: ready,
              message: ready ? '目标与凭据就绪' : '待校验上游依赖'
            }
          ]
        })
        return
      }
      if (['publish', 'rollback', 'status'].includes(operation) && method === 'POST') {
        const input = body()
        state.writes.push({ path: url.pathname, body: input })
        const row = state.records.find((item) => item.interfaceId === interfaceId)
        if (!row) throw new Error('Synthetic release record missing')
        if (state.failNextStatus && operation === 'status') {
          state.failNextStatus = false
          await reply({ code: 'BFF_CONFLICT', message: '运行版本已变化，请刷新后重试' }, 409)
          return
        }
        if (input.deploymentVersion !== (row.deployment?.version ?? 0)) {
          await reply({ code: 'BFF_CONFLICT', message: '运行版本已变化，请刷新后重试' }, 409)
          return
        }
        let action: ReleaseEvent['action']
        let activeVersion: ReleaseVersion
        if (operation === 'publish') {
          if (input.draftVersion !== row.draftVersion) throw new Error('Draft CAS was not sent')
          const number = state.versions.length + 1
          activeVersion = {
            id: `${number}8888888-8888-4888-8888-888888888888`,
            interfaceId,
            number,
            draftVersion: row.draftVersion,
            checksum: `fixture-checksum-${number}`,
            notes: String(input.notes),
            createdAt: timestamp,
            createdByName: '合成管理员',
            applicationId: appId,
            environment: row.environment,
            code: row.code,
            name: row.name,
            description: row.description,
            method: row.draftMethod,
            path: row.draftPath,
            definition: structuredClone(definition)
          }
          state.versions.unshift(activeVersion)
          action = 'publish'
        } else if (operation === 'rollback') {
          activeVersion = state.versions.find((item) => item.id === input.targetVersionId)!
          if (!activeVersion) throw new Error('Rollback target was not selected')
          action = 'rollback'
        } else {
          activeVersion = state.versions.find(
            (item) => item.id === row.deployment?.activeVersionId
          )!
          if (!activeVersion) throw new Error('Status target was not published')
          action = input.enabled === true ? 'enable' : 'disable'
        }
        const previous = row.deployment?.activeVersionNumber ?? null
        row.deployment = {
          version: (row.deployment?.version ?? 0) + 1,
          enabled:
            operation === 'status'
              ? input.enabled === true
              : operation === 'rollback'
                ? (row.deployment?.enabled ?? true)
                : true,
          activeVersionId: activeVersion.id,
          activeVersionNumber: activeVersion.number,
          method: activeVersion.method,
          path: activeVersion.path,
          updatedAt: timestamp,
          updatedByName: '合成管理员'
        }
        row.versionCount = state.versions.length
        state.events.unshift({
          id: `${state.events.length + 1}9999999-9999-4999-8999-999999999999`,
          action,
          fromVersionNumber: previous,
          toVersionNumber: activeVersion.number,
          deploymentVersion: row.deployment.version,
          notes: String(input.notes),
          createdAt: timestamp,
          actorName: '合成管理员'
        })
        await reply(history(state, interfaceId))
        return
      }
    }
    state.unexpected.push(`${method} ${url.pathname}`)
    await reply({ code: 'UNEXPECTED', message: '未配置的合成接口' }, 404)
  })
  return state
}

test('two unpublished interfaces can be searched and an unready draft is blocked', async ({
  page
}) => {
  const state = await mockApi(page)
  await page.goto('/releases')
  await expect(page.getByRole('heading', { name: '版本发布' })).toBeVisible()
  if (await page.getByText('知道了', { exact: true }).count())
    await page.getByText('知道了', { exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：订单状态接口' })).toBeVisible()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存核对接口' })).toBeVisible()
  const keyword = page.getByPlaceholder('搜索名称或编码')
  await keyword.fill('订单状态')
  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByRole('row').filter({ hasText: '验收示例：库存核对接口' })).toHaveCount(0)
  await keyword.fill('不存在的接口')
  await page.getByRole('button', { name: '查询' }).click()
  await expect(page.getByText('暂无符合条件的接口版本')).toBeVisible()
  await page.getByRole('button', { name: '重置' }).click()
  const unready = page.getByRole('row').filter({ hasText: '验收示例：库存核对接口' })
  await unready.getByRole('button', { name: '发布草稿' }).click()
  const dialog = page.getByRole('dialog', { name: '发布接口' })
  await expect(dialog.getByText('请先验证定义并完成测试')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '确认发布' })).toBeDisabled()
  expect(state.writes).toHaveLength(0)
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('publish V1 and V2, inspect snapshots, rollback V1, disable and enable with CAS', async ({
  page
}) => {
  test.setTimeout(110_000)
  const state = await mockApi(page)
  await page.goto('/releases')
  await expect(page.getByRole('heading', { name: '版本发布' })).toBeVisible()
  const row = () => page.getByRole('row').filter({ hasText: '验收示例：订单状态接口' })
  async function command(title: string, notes: string): Promise<void> {
    const dialog = page.getByRole('dialog', { name: title })
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('写明变更原因、影响范围和回退依据').fill(notes)
    await dialog.getByRole('button', { name: `确认${title.replace('接口', '')}` }).click()
    if (title === '停用接口' || title === '启用接口') {
      const dialogs = page.getByRole('dialog', { name: title })
      await expect(dialogs).toHaveCount(2)
      await dialogs
        .last()
        .getByRole('button', { name: `确认${title.replace('接口', '')}` })
        .click()
    }
    await expect(dialog).toHaveCount(0)
  }
  await row().getByRole('button', { name: '发布草稿' }).click()
  await command('发布接口', '首次发布，已核对订单查询和上游依赖')
  expect(state.writes[0]?.body).toMatchObject({ draftVersion: 1, deploymentVersion: 0 })
  await expect(row().getByText('V1', { exact: true })).toBeVisible()
  await expect(row().getByText('/api/gateway/demo-ops/development/orders/{orderId}')).toBeVisible()

  state.records[0].draftVersion = 2
  state.records[0].lastTestVersion = 2
  await page.reload()
  await expect(row().getByText('草稿 v2')).toBeVisible()
  await expect(row().getByText('V1', { exact: true })).toBeVisible()
  await row().getByRole('button', { name: '发布草稿' }).click()
  await command('发布接口', '第二版已验证，保留独立草稿版本')
  expect(state.writes[1]?.body).toMatchObject({ draftVersion: 2, deploymentVersion: 1 })
  await expect(row().getByText('V2', { exact: true })).toBeVisible()

  await row().getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '版本历史' }).click()
  const historyDialog = page.getByRole('dialog', { name: '版本历史' })
  await expect(historyDialog.getByRole('button', { name: /V1/ })).toBeVisible()
  await expect(historyDialog.getByRole('button', { name: /V2/ })).toBeVisible()
  await historyDialog.getByRole('button', { name: 'V1', exact: true }).click()
  await expect(historyDialog.getByRole('button', { name: 'V1', exact: true })).toHaveClass(
    /el-button--primary/
  )
  await expect(
    historyDialog
      .getByRole('tabpanel', { name: '版本快照' })
      .getByText('首次发布，已核对订单查询和上游依赖', { exact: true })
  ).toBeVisible()
  await page.waitForTimeout(300) // Capture after the selected-version button finishes its visual transition.
  const screenshotPath = path.resolve('.artifacts/ui/release-history-two-versions.png')
  mkdirSync(path.dirname(screenshotPath), { recursive: true })
  await page.screenshot({ path: screenshotPath })
  await historyDialog.getByRole('button', { name: '回滚到 V1' }).click()
  await command('回滚接口', '回滚至首版快照以恢复上游兼容')
  expect(state.versions).toHaveLength(2)
  expect(state.writes[2]?.body).toMatchObject({
    targetVersionId: state.versions[1].id,
    deploymentVersion: 2
  })
  await expect(row().getByText('V1', { exact: true })).toBeVisible()

  await row().getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '停用接口' }).click()
  await command('停用接口', '临时停用接口，排查外部调用影响')
  await expect(row().getByText('已停用')).toBeVisible()
  await row().getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '版本历史' }).click()
  const disabledHistory = page.getByRole('dialog', { name: '版本历史' })
  await disabledHistory.getByRole('button', { name: 'V2', exact: true }).click()
  await disabledHistory.getByRole('button', { name: '回滚到 V2' }).click()
  const disabledRollback = page.getByRole('dialog', { name: '回滚接口' })
  await expect(disabledRollback.getByText('接口保持停用')).toBeVisible()
  await command('回滚接口', '停用期间回滚到第二版，保持调用入口关闭')
  expect(state.writes.at(-1)?.body).toMatchObject({ targetVersionId: state.versions[0].id })
  await expect(row().getByText('V2', { exact: true })).toBeVisible()
  await expect(row().getByText('已停用')).toBeVisible()
  await row().getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '启用接口' }).click()
  await command('启用接口', '依赖检查通过，恢复同源调用')
  await expect(row().getByText('已启用')).toBeVisible()

  state.failNextStatus = true
  await row().getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '停用接口' }).click()
  const staleDialog = page.getByRole('dialog', { name: '停用接口' })
  await staleDialog
    .getByPlaceholder('写明变更原因、影响范围和回退依据')
    .fill('故意模拟并发版本冲突')
  await staleDialog.getByRole('button', { name: '确认停用' }).click()
  await page.getByRole('button', { name: '确认停用' }).last().click()
  await expect(staleDialog.getByText('运行版本已变化，请刷新后重试')).toBeVisible()
  expect(state.versions).toHaveLength(2)
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('release workspace preserves focus controls and scrollable dialog footer across visual modes', async ({
  page
}) => {
  test.setTimeout(90_000)
  const state = await mockApi(page)
  state.versions = Array.from({ length: 18 }, (_, index): ReleaseVersion => {
    const number = 18 - index
    return {
      id: `${number.toString(16).padStart(8, '0')}-8888-4888-8888-888888888888`,
      interfaceId: firstId,
      number,
      draftVersion: number,
      checksum: `synthetic-checksum-${number}`,
      notes: `历史版本 ${number} 的受控变更说明`,
      applicationId: appId,
      environment: 'development',
      code: 'order-status',
      name: '验收示例：订单状态接口',
      description: '仅用于模拟发布流程',
      method: 'GET',
      path: '/orders/{orderId}',
      definition: structuredClone(definition),
      createdAt: timestamp,
      createdByName: '合成管理员'
    }
  })
  state.records[0].versionCount = state.versions.length
  state.records[0].deployment = {
    version: 18,
    enabled: true,
    activeVersionId: state.versions[0].id,
    activeVersionNumber: 18,
    method: 'GET',
    path: '/orders/{orderId}',
    updatedAt: timestamp,
    updatedByName: '合成管理员'
  }
  state.events = state.versions.map((version, index): ReleaseEvent => ({
    id: `${(index + 1).toString(16).padStart(8, '0')}-9999-4999-8999-999999999999`,
    action: 'publish',
    fromVersionNumber: index === 17 ? null : version.number - 1,
    toVersionNumber: version.number,
    deploymentVersion: version.number,
    notes: version.notes,
    createdAt: timestamp,
    actorName: '合成管理员'
  }))
  const artifactRoot = path.resolve('.artifacts/ui')
  mkdirSync(artifactRoot, { recursive: true })
  await page.goto('/releases')
  await expect(page.getByRole('heading', { name: '版本发布' })).toBeVisible()
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.dataset.boxMode = 'border-mode'
  })
  await page.screenshot({ path: path.join(artifactRoot, 'release-light-border-1440.png') })
  await page
    .locator('.el-switch')
    .filter({ has: page.getByRole('switch', { name: '进入专注模式' }) })
    .click()
  await expect(page.getByRole('button', { name: '退出专注模式' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '版本发布' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '版本发布' })).toBeVisible()
  await expect(page.getByRole('switch', { name: '进入专注模式' })).toHaveAttribute(
    'aria-checked',
    'false'
  )

  await page
    .getByRole('row')
    .filter({ hasText: '验收示例：库存核对接口' })
    .getByRole('button', { name: '发布草稿' })
    .click()
  const publishDialog = page.getByRole('dialog', { name: '发布接口' })
  await expect(publishDialog.getByRole('button', { name: '确认发布' })).toBeDisabled()
  await page.screenshot({ path: path.join(artifactRoot, 'release-publish-light-1440.png') })
  await publishDialog.getByRole('button', { name: '取消', exact: true }).click()

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
    document.documentElement.dataset.boxMode = 'shadow-mode'
  })
  await page.screenshot({ path: path.join(artifactRoot, 'release-dark-shadow-1280.png') })
  const firstRow = page.getByRole('row').filter({ hasText: '验收示例：订单状态接口' })
  await firstRow.getByRole('button', { name: '更多操作' }).hover()
  await page.getByRole('menuitem', { name: '版本历史' }).click()
  const historyDialog = page.getByRole('dialog', { name: '版本历史' })
  await expect(historyDialog.getByRole('button', { name: 'V18', exact: false })).toBeVisible()
  const footer = historyDialog.locator('.art-dialog__footer')
  await expect(footer).toBeVisible()
  await historyDialog
    .locator('.el-scrollbar__wrap')
    .first()
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
  await expect(footer).toBeInViewport()
  await page.waitForTimeout(350)
  await page.screenshot({ path: path.join(artifactRoot, 'release-history-dark-1280.png') })
  await historyDialog.getByRole('button', { name: '关闭', exact: true }).click()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => {
    document.documentElement.classList.remove('dark')
    document.documentElement.dataset.boxMode = 'border-mode'
  })
  await page.screenshot({ path: path.join(artifactRoot, 'release-mobile-list-390.png') })
  await firstRow.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '版本历史' }).click()
  const mobileHistory = page.getByRole('dialog', { name: '版本历史' })
  await mobileHistory
    .locator('.el-scrollbar__wrap')
    .first()
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
  await expect(mobileHistory.locator('.art-dialog__footer')).toBeInViewport()
  await page.screenshot({ path: path.join(artifactRoot, 'release-mobile-history-390.png') })
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('pagination stays at the bottom of the workspace', async ({ page }) => {
  await mockApi(page)
  await checkPaginationLayouts(page, '/releases')
})
