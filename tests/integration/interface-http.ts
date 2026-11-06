/** Real BFF HTTP/interface workflow against a loopback responder and isolated BFF identities.
 * No pro authentication or user-configured upstream is contacted.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import path from 'node:path'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config } from '../../server/config'
import { database, requireData } from '../../server/database/client'
import { digest, opaqueToken, seal } from '../../server/security'
import type { InterfaceWriteInput } from '../../src/types/interface'
import { inputBinding, interfaceFixture, stepBinding } from '../fixtures/interface-definition'

assert.equal(new URL(config.databaseUrl).hostname, 'bksbwnxdurmuolygiofh.supabase.co')
const bffOrigin = process.env.BFF_TEST_ORIGIN || 'http://localhost:3012'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(bffOrigin).hostname))
const responderOrigin = 'http://127.0.0.1:33441'
const manifest = path.resolve('.artifacts/upstream-http-fixtures.json')
const tenantA = randomUUID(),
  tenantB = randomUUID()
const adminA = randomUUID(),
  viewerA = randomUUID(),
  adminB = randomUUID()
const memberIds = [adminA, viewerA, adminB]
const tokens = memberIds.map(() => opaqueToken())
const csrf = 'bff-interface-http-fixture-csrf'
const secret = `fixture-interface-key-${randomUUID()}`
const rotatedSecret = `fixture-interface-rotated-${randomUUID()}`
const requests: Array<{ method: string; url: string; authorization: string; body: string }> = []
let raceStarted: (() => void) | undefined
let raceRelease: (() => void) | undefined
let raceStartedPromise = Promise.resolve()
let raceReleasePromise = Promise.resolve()
function beginRace(): void {
  raceStartedPromise = new Promise<void>((resolve) => {
    raceStarted = resolve
  })
  raceReleasePromise = new Promise<void>((resolve) => {
    raceRelease = resolve
  })
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
const responder = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const requestUrl = request.url || ''
    requests.push({
      method: request.method || '',
      url: requestUrl,
      authorization: String(request.headers.authorization || ''),
      body: Buffer.concat(chunks).toString('utf8')
    })
    const parsed = new URL(requestUrl, responderOrigin)
    if (parsed.pathname.startsWith('/v1/orders/')) {
      if (parsed.pathname.endsWith('/fail')) {
        json(response, 422, { privateDetail: 'sensitive-upstream-error' })
        return
      }
      json(response, 200, {
        orderNo: decodeURIComponent(parsed.pathname.slice('/v1/orders/'.length)),
        customerId: 'cust-01'
      })
      return
    }
    if (parsed.pathname === '/v1/customers/cust-01') {
      json(response, 200, { name: '示例客户' })
      return
    }
    if (parsed.pathname === '/v1/quote/preview') {
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!isObjectRecord(input) || typeof input.weight !== 'number') {
        json(response, 400, { privateDetail: 'invalid fixture input' })
        return
      }
      json(response, 200, { amount: input.weight * 4, echo: request.headers.authorization })
      return
    }
    if (parsed.pathname === '/v1/quote/race') {
      raceStarted?.()
      await raceReleasePromise
      if (!response.destroyed) json(response, 200, { amount: 88 })
      return
    }
    json(response, 404, { privateDetail: 'unknown fixture path' })
  })().catch(() => {
    if (!response.destroyed) json(response, 500, { privateDetail: 'fixture failed' })
  })
})
function record(value: unknown): Record<string, unknown> {
  assert.ok(isObjectRecord(value))
  return value
}
function list(value: unknown): Record<string, unknown>[] {
  const result = record(value).records
  assert.ok(Array.isArray(result) && result.every(isObjectRecord))
  return result
}
async function api(
  index: number,
  route: string,
  method = 'GET',
  payload?: unknown,
  overrides: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${bffOrigin}${route}`, {
    method,
    headers: {
      Cookie: `bff_session=${tokens[index]}`,
      Origin: bffOrigin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
      ...overrides
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  })
  return { status: response.status, body: await response.json() }
}
async function app(actor: string, code: string): Promise<string> {
  const result = await database.rpc('bff_save_application', {
    p_actor: actor,
    p_id: null,
    p_version: null,
    p_code: code,
    p_name: code,
    p_description: '',
    p_home_url: '',
    p_enabled: true
  })
  const id = record(requireData(result)).id
  assert.ok(typeof id === 'string')
  return id
}
async function upstream(
  index: number,
  applicationId: string,
  code: string,
  credential?: string
): Promise<Record<string, unknown>> {
  const input = {
    applicationId,
    code,
    name: code,
    description: '合成接口联调服务',
    environment: 'development',
    baseUrl: `${responderOrigin}/v1`,
    authType: credential ? 'bearer' : 'none',
    headerName: credential ? 'Authorization' : '',
    timeoutMs: 5000,
    ...(credential ? { credential } : {})
  }
  const created = await api(index, '/api/upstreams', 'POST', input)
  assert.equal(created.status, 201)
  const row = record(created.body)
  const activated = await api(index, `/api/upstreams/${row.id}/status`, 'POST', {
    status: 'active',
    version: row.version
  })
  assert.equal(activated.status, 200)
  return record(activated.body)
}
function quoteDefinition(applicationId: string, upstreamId: string): InterfaceWriteInput {
  const base = interfaceFixture(applicationId, upstreamId)
  return {
    ...base,
    code: 'freight-preview',
    name: '运费预览',
    method: 'POST',
    path: '/quote/preview',
    definition: {
      inputs: [{ key: 'weight', label: '重量', location: 'body', type: 'number', required: true }],
      steps: [
        {
          key: 'quote',
          name: '运费试算',
          upstreamId,
          configVersion: 1,
          method: 'POST',
          path: '/quote/preview',
          pathParams: [],
          query: [],
          body: [inputBinding('weight')]
        }
      ],
      outputs: [stepBinding('amount', 'quote', '/amount')]
    }
  }
}
async function createInterface(
  index: number,
  input: InterfaceWriteInput
): Promise<Record<string, unknown>> {
  const response = await api(index, '/api/interfaces', 'POST', input)
  assert.equal(response.status, 201)
  return record(response.body)
}
function publicSafe(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const forbidden of [
    secret,
    rotatedSecret,
    'ciphertext',
    'keyId',
    'sensitive-upstream-error'
  ])
    assert.ok(!serialized.includes(forbidden), 'response leaked private upstream data')
}
async function run(): Promise<void> {
  if (existsSync(manifest))
    throw new Error('An earlier upstream fixture manifest requires cleanup first')
  responder.listen(33441, '127.0.0.1')
  await once(responder, 'listening')
  mkdirSync(path.dirname(manifest), { recursive: true })
  writeFileSync(manifest, JSON.stringify({ tenantIds: [tenantA, tenantB], memberIds }), 'utf8')
  let runError: unknown
  let cleanupError: unknown
  try {
    requireData(
      await database
        .from('bff_members')
        .insert(
          memberIds.map((id, index) => ({
            id,
            issuer: config.issuer,
            subject: `bff-upstream-fixture:${id}`,
            tenant_id: index === 2 ? tenantB : tenantA,
            role: index === 1 ? 'viewer' : 'admin',
            email: `bff-interface-fixture-${index}@example.test`,
            display_name: `Interface HTTP ${index}`
          }))
        )
        .select('id')
    )
    requireData(
      await database
        .from('bff_sessions')
        .insert(
          memberIds.map((id, index) => ({
            token_hash: digest(tokens[index]),
            member_id: id,
            csrf_token: csrf,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            payload: seal(
              {
                accessToken: 'synthetic-never-pro-oauth',
                refreshToken: '',
                expiresAt: Date.now() + 30 * 60_000,
                subject: `bff-upstream-fixture:${id}`
              },
              config.sessionKey
            )
          }))
        )
        .select('token_hash')
    )
    const appA = await app(adminA, 'http-interface-a')
    const appOther = await app(adminA, 'http-interface-other')
    const appB = await app(adminB, 'http-interface-b')
    const grant = await database.rpc('bff_set_application_member', {
      p_actor: adminA,
      p_application: appA,
      p_member: viewerA,
      p_granted: true
    })
    assert.equal(grant.error, null)
    const pageId = randomUUID(),
      roleId = randomUUID()
    requireData(
      await database
        .from('bff_menus')
        .insert([
          {
            id: pageId,
            tenant_id: tenantA,
            name: 'FixtureInterfaceHttp',
            type: 'menu',
            path: '/fixture-interface-http',
            component: '/bff/interfaces/index',
            meta: { title: 'Interface fixture', isEnable: true },
            create_by: adminA,
            update_by: adminA
          },
          ...(['View', 'Test', 'TestWrite'] as const).map((action) => ({
            id: randomUUID(),
            tenant_id: tenantA,
            parent_id: pageId,
            name: `BffInterface:${action}`,
            type: 'button',
            path: '',
            component: '',
            meta: { title: action, isEnable: true },
            create_by: adminA,
            update_by: adminA
          }))
        ])
        .select('id')
    )
    requireData(
      await database
        .from('bff_roles')
        .insert({
          id: roleId,
          tenant_id: tenantA,
          role_code: 'FixtureInterfaceHttpReader',
          role_name: 'Interface fixture reader',
          create_by: adminA,
          update_by: adminA
        })
        .select('id')
    )
    requireData(
      await database
        .from('bff_member_roles')
        .insert({
          tenant_id: tenantA,
          member_id: viewerA,
          role_id: roleId,
          create_by: adminA
        })
        .select('member_id')
    )
    const viewButton = record(
      requireData(
        await database
          .from('bff_menus')
          .select('id')
          .eq('tenant_id', tenantA)
          .eq('name', 'BffInterface:View')
          .single()
      )
    )
    requireData(
      await database
        .from('bff_role_menus')
        .insert({
          tenant_id: tenantA,
          role_id: roleId,
          menu_id: viewButton.id,
          create_by: adminA
        })
        .select('menu_id')
    )

    assert.equal((await fetch(`${bffOrigin}/api/health`)).status, 200)
    const options = await api(0, '/api/interfaces/options')
    assert.equal(options.status, 200)
    const firstService = await upstream(0, appA, 'interface-orders')
    const quoteService = await upstream(0, appA, 'interface-quote', secret)
    const otherService = await upstream(0, appOther, 'interface-other')
    const foreignService = await upstream(2, appB, 'interface-foreign')
    for (const response of [firstService, quoteService, otherService, foreignService])
      publicSafe(response)
    const orderInput = interfaceFixture(appA, String(firstService.id))
    orderInput.definition.inputs.push({
      key: 'include',
      label: '关联范围',
      location: 'query',
      type: 'string',
      required: true
    })
    orderInput.definition.steps[0].query.push(inputBinding('include'))
    const order = await createInterface(0, orderInput)
    const quoteInput = quoteDefinition(appA, String(quoteService.id))
    const invalidQuote = structuredClone(quoteInput)
    invalidQuote.definition.steps[0].body = [stepBinding('weight', 'later', '/amount')]
    const quote = await createInterface(0, invalidQuote)
    const other = await createInterface(0, {
      ...interfaceFixture(appOther, String(otherService.id)),
      code: 'other-preview',
      name: '其他应用预览',
      path: '/other/{orderId}'
    })
    const foreign = await createInterface(2, {
      ...interfaceFixture(appB, String(foreignService.id)),
      code: 'foreign-preview',
      name: '外租户预览',
      path: '/foreign/{orderId}'
    })
    for (const response of [order, quote, other, foreign]) publicSafe(response)
    const orderId = String(order.id),
      quoteId = String(quote.id)
    assert.equal(record((await api(0, '/api/interfaces?size=20')).body).total, 3)
    assert.equal(record((await api(1, '/api/interfaces?size=20')).body).total, 2)
    assert.equal(record((await api(2, '/api/interfaces?size=20')).body).total, 1)
    assert.equal(record((await api(1, `/api/interfaces?applicationId=${appOther}`)).body).total, 0)
    assert.equal(record((await api(0, `/api/interfaces?recordId=${foreign.id}`)).body).total, 0)
    assert.equal(record((await api(0, `/api/interfaces?name=freight-preview`)).body).total, 1)
    assert.equal(record((await api(0, `/api/interfaces?name=运费预览`)).body).total, 1)
    const viewerOptions = await api(1, '/api/interfaces/options')
    assert.equal(viewerOptions.status, 200)
    const viewerApps = record(viewerOptions.body).applications
    const viewerUpstreams = record(viewerOptions.body).upstreams
    assert.ok(Array.isArray(viewerApps) && Array.isArray(viewerUpstreams))
    assert.equal(viewerApps.length, 1)
    assert.equal(viewerUpstreams.length, 2)
    assert.equal(list((await api(0, '/api/interfaces?size=20')).body).length, 3)

    const beforeDenied = requests.length
    assert.equal(
      (
        await api(1, `/api/interfaces/${orderId}/tests`, 'POST', {
          version: 1,
          input: { orderId: 'ORDER 1', include: 'customer' }
        })
      ).status,
      403
    )
    assert.equal(
      (
        await api(0, `/api/interfaces/${foreign.id}/tests`, 'POST', {
          version: 1,
          input: { orderId: 'ORDER 1' }
        })
      ).status,
      404
    )
    assert.equal(
      (
        await api(
          0,
          `/api/interfaces/${orderId}/tests`,
          'POST',
          {
            version: 1,
            input: { orderId: 'ORDER 1', include: 'customer' }
          },
          { Origin: 'https://forged.example' }
        )
      ).status,
      403
    )
    assert.equal(
      (
        await api(
          0,
          `/api/interfaces/${orderId}/tests`,
          'POST',
          {
            version: 1,
            input: { orderId: 'ORDER 1', include: 'customer' }
          },
          { 'X-CSRF-Token': 'wrong' }
        )
      ).status,
      403
    )
    assert.equal(requests.length, beforeDenied)
    assert.equal((await api(1, '/api/interfaces', 'POST', orderInput)).status, 403)
    assert.equal(
      (
        await api(0, '/api/interfaces', 'POST', {
          ...interfaceFixture(appA, String(foreignService.id)),
          code: 'cross-upstream',
          path: '/cross/{orderId}'
        })
      ).status,
      409
    )
    assert.equal(
      (
        await api(0, `/api/interfaces/${orderId}`, 'PUT', {
          ...orderInput,
          name: '过期草稿',
          version: 99
        })
      ).status,
      409
    )
    assert.equal(
      (
        await api(0, `/api/interfaces/${orderId}/tests`, 'POST', {
          version: 1,
          input: { orderId: 'ORDER 1', include: 'customer' }
        })
      ).status,
      409
    )
    assert.equal(requests.length, beforeDenied)
    const invalidValidated = await api(0, `/api/interfaces/${quoteId}/validate`, 'POST', {
      version: 1
    })
    assert.equal(invalidValidated.status, 200)
    assert.equal(record(invalidValidated.body).validationStatus, 'invalid')
    assert.ok((record(invalidValidated.body).validationIssues as unknown[]).length > 0)
    const corrected = await api(0, `/api/interfaces/${quoteId}`, 'PUT', {
      ...quoteInput,
      version: 1
    })
    assert.equal(corrected.status, 200)
    assert.equal(record(corrected.body).version, 2)
    assert.equal(record(corrected.body).validationStatus, 'unvalidated')
    const quoteValidated = await api(0, `/api/interfaces/${quoteId}/validate`, 'POST', {
      version: 2
    })
    assert.equal(quoteValidated.status, 200)
    assert.equal(record(quoteValidated.body).validationStatus, 'valid')
    const orderValidated = await api(0, `/api/interfaces/${orderId}/validate`, 'POST', {
      version: 1
    })
    assert.equal(orderValidated.status, 200)
    assert.equal(record(orderValidated.body).validatedVersion, 1)
    const viewerInput = structuredClone(orderInput)
    viewerInput.code = 'viewer-preview'
    viewerInput.name = '成员只读试运行'
    viewerInput.path = '/viewer/{orderId}'
    const viewerInterface = await createInterface(0, viewerInput)
    assert.equal(
      (
        await api(0, `/api/interfaces/${viewerInterface.id}/validate`, 'POST', {
          version: 1
        })
      ).status,
      200
    )
    const testButton = record(
      requireData(
        await database
          .from('bff_menus')
          .select('id')
          .eq('tenant_id', tenantA)
          .eq('name', 'BffInterface:Test')
          .single()
      )
    )
    requireData(
      await database
        .from('bff_role_menus')
        .insert({
          tenant_id: tenantA,
          role_id: roleId,
          menu_id: testButton.id,
          create_by: adminA
        })
        .select('menu_id')
    )
    const viewerRead = await api(1, `/api/interfaces/${viewerInterface.id}/tests`, 'POST', {
      version: 1,
      input: { orderId: 'VIEW 1', include: 'customer' }
    })
    assert.equal(viewerRead.status, 200)
    assert.equal(record(viewerRead.body).passed, true)
    const beforeWriteDenied = requests.length
    assert.equal(
      (
        await api(1, `/api/interfaces/${quoteId}/tests`, 'POST', {
          version: 2,
          input: { weight: 1 }
        })
      ).status,
      403
    )
    assert.equal(
      (
        await api(1, `/api/interfaces/${other.id}/tests`, 'POST', {
          version: 1,
          input: { orderId: 'X' }
        })
      ).status,
      403
    )
    assert.equal(requests.length, beforeWriteDenied)

    const prodService = await api(0, '/api/upstreams', 'POST', {
      applicationId: appA,
      code: 'interface-production-draft',
      name: '生产草稿服务',
      description: '',
      environment: 'production',
      baseUrl: 'https://example.test/v1',
      authType: 'none',
      headerName: '',
      timeoutMs: 5000
    })
    assert.equal(prodService.status, 201)
    const productionInput = quoteDefinition(appA, String(record(prodService.body).id))
    productionInput.environment = 'production'
    productionInput.code = 'production-write-preview'
    productionInput.name = '生产写请求限制'
    productionInput.path = '/production/quote'
    const productionDraft = await createInterface(0, productionInput)
    assert.equal(
      (
        await api(0, `/api/interfaces/${productionDraft.id}/validate`, 'POST', {
          version: 1
        })
      ).status,
      200
    )
    const beforeProductionDenied = requests.length
    assert.equal(
      (
        await api(0, `/api/interfaces/${productionDraft.id}/tests`, 'POST', {
          version: 1,
          input: { weight: 1 }
        })
      ).status,
      403
    )
    assert.equal(requests.length, beforeProductionDenied)
    assert.equal(
      (
        await api(0, `/api/interfaces/${orderId}/tests`, 'POST', {
          version: 1,
          input: { orderId: 'ORDER 1', include: 'customer', unexpected: 'forbidden' }
        })
      ).status,
      400
    )
    assert.equal(requests.length, beforeProductionDenied)
    const orderResult = await api(0, `/api/interfaces/${orderId}/tests`, 'POST', {
      version: 1,
      input: { orderId: 'ORDER 1', include: 'customer' }
    })
    assert.equal(orderResult.status, 200)
    assert.equal(record(orderResult.body).passed, true)
    assert.deepEqual(record(orderResult.body).output, {
      orderNo: 'ORDER 1',
      customerName: '示例客户'
    })
    const orderSteps = record(orderResult.body).steps
    assert.ok(Array.isArray(orderSteps) && orderSteps.every(isObjectRecord))
    assert.deepEqual(
      orderSteps.map((step) => step.status),
      ['passed', 'passed']
    )
    const orderRequests = requests.slice(-2)
    assert.equal(orderRequests[0]?.url, '/v1/orders/ORDER%201?include=customer')
    assert.equal(orderRequests[1]?.url, '/v1/customers/cust-01')
    assert.equal(orderRequests[0]?.authorization, '')
    publicSafe(orderResult.body)
    const failureInput = structuredClone(orderInput)
    failureInput.code = 'failure-preview'
    failureInput.name = '失败停止后续步骤'
    failureInput.path = '/failure/{orderId}'
    const failure = await createInterface(0, failureInput)
    assert.equal(
      (await api(0, `/api/interfaces/${failure.id}/validate`, 'POST', { version: 1 })).status,
      200
    )
    const beforeFailure = requests.length
    const failureResult = await api(0, `/api/interfaces/${failure.id}/tests`, 'POST', {
      version: 1,
      input: { orderId: 'fail', include: 'customer' }
    })
    assert.equal(failureResult.status, 200)
    assert.equal(record(failureResult.body).passed, false)
    const failureSteps = record(failureResult.body).steps
    assert.ok(Array.isArray(failureSteps) && failureSteps.every(isObjectRecord))
    assert.deepEqual(
      failureSteps.map((step) => step.status),
      ['failed', 'skipped']
    )
    assert.equal(requests.length, beforeFailure + 1)
    publicSafe(failureResult.body)
    assert.equal((await api(0, `/api/interfaces/${failure.id}/references`)).status, 200)
    assert.equal(
      (await api(0, `/api/interfaces/${failure.id}`, 'DELETE', { version: 1 })).status,
      200
    )
    const quoteResult = await api(0, `/api/interfaces/${quoteId}/tests`, 'POST', {
      version: 2,
      input: { weight: 12.5 }
    })
    assert.equal(quoteResult.status, 200)
    publicSafe(quoteResult.body)
    assert.equal(record(quoteResult.body).passed, true)
    assert.deepEqual(record(quoteResult.body).output, { amount: 50 })
    assert.equal(requests.at(-1)?.method, 'POST')
    assert.deepEqual(JSON.parse(requests.at(-1)?.body || '{}'), { weight: 12.5 })
    assert.ok(requests.at(-1)?.authorization === `Bearer ${secret}`)

    const refs = await api(0, `/api/upstreams/${firstService.id}/references`)
    assert.equal(refs.status, 200)
    assert.ok(
      Array.isArray(refs.body) &&
        refs.body.some(
          (item: unknown) =>
            isObjectRecord(item) &&
            item.sourceTable === 'bff_interfaces' &&
            item.recordId === orderId
        )
    )
    const stopped = await api(0, `/api/upstreams/${firstService.id}/status`, 'POST', {
      status: 'disabled',
      version: firstService.version
    })
    assert.equal(stopped.status, 200)
    assert.equal(
      (
        await api(0, `/api/upstreams/${firstService.id}`, 'DELETE', {
          version: record(stopped.body).version
        })
      ).status,
      409
    )

    const echoDefinition = quoteDefinition(appA, String(quoteService.id))
    echoDefinition.code = 'echo-preview'
    echoDefinition.name = '凭据隔离预览'
    echoDefinition.path = '/quote/echo'
    echoDefinition.definition.outputs = [stepBinding('echo', 'quote', '/echo')]
    const echo = await createInterface(0, echoDefinition)
    const echoValidated = await api(0, `/api/interfaces/${echo.id}/validate`, 'POST', {
      version: 1
    })
    assert.equal(echoValidated.status, 200)
    const echoResult = await api(0, `/api/interfaces/${echo.id}/tests`, 'POST', {
      version: 1,
      input: { weight: 1 }
    })
    assert.equal(echoResult.status, 200)
    publicSafe(echoResult.body)
    assert.equal(record(echoResult.body).passed, false)
    assert.deepEqual(record(echoResult.body).output, {})

    const raceDefinition = quoteDefinition(appA, String(quoteService.id))
    raceDefinition.code = 'race-preview'
    raceDefinition.name = '并发凭据测试'
    raceDefinition.path = '/quote/race'
    raceDefinition.definition.steps[0].path = '/quote/race'
    const race = await createInterface(0, raceDefinition)
    assert.equal(
      (await api(0, `/api/interfaces/${race.id}/validate`, 'POST', { version: 1 })).status,
      200
    )
    beginRace()
    const runningTest = api(0, `/api/interfaces/${race.id}/tests`, 'POST', {
      version: 1,
      input: { weight: 2 }
    })
    await Promise.race([
      raceStartedPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('Controlled interface test did not start')),
          15_000
        ).unref()
      })
    ])
    const rotated = await api(0, `/api/upstreams/${quoteService.id}/credential`, 'PUT', {
      action: 'rotate',
      version: quoteService.version,
      credential: rotatedSecret
    })
    assert.equal(rotated.status, 200)
    raceRelease?.()
    const stale = await runningTest
    assert.equal(stale.status, 200)
    publicSafe(stale.body)
    assert.equal(record(stale.body).stale, true)
    assert.equal(record(stale.body).passed, false)
    assert.deepEqual(record(stale.body).output, {})
    const audit = requireData(
      await database
        .from('bff_audit_events')
        .select('action,summary')
        .eq('tenant_id', tenantA)
        .like('action', 'interface.%')
    )
    assert.ok(audit.length >= 7)
    publicSafe(audit)
    console.log(
      'Interface HTTP checks passed: draft CRUD, validation, two-step mapping, permissions, credential isolation, stale race and references.'
    )
  } catch (error) {
    runError = error
  } finally {
    raceRelease?.()
    responder.closeAllConnections()
    await new Promise<void>((resolve) => responder.close(() => resolve()))
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-File',
          'scripts/supabase-management.ps1',
          '-Action',
          'CleanupUpstreamFixtures'
        ],
        { cwd: process.cwd(), timeout: 120_000, stdio: 'pipe' }
      )
      console.log('Synthetic interface HTTP fixtures removed.')
    } catch (error) {
      cleanupError = error
    }
  }
  if (runError || cleanupError)
    throw new AggregateError(
      [...(runError ? [runError] : []), ...(cleanupError ? [cleanupError] : [])],
      'Interface HTTP verification failed'
    )
}
await run()
