/** Real release/gateway workflow with synthetic BFF identities and a loopback upstream.
 * Run serially with other HTTP fixtures; it never calls pro Auth or a user upstream.
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
const csrf = 'bff-release-http-fixture-csrf'
const secret = `fixture-release-key-${randomUUID()}`
const rotatedSecret = `fixture-release-rotated-${randomUUID()}`
const requests: Array<{ method: string; url: string; authorization: string; body: string }> = []
let holdRace = false
let raceStart: (() => void) | undefined
let raceFinish: (() => void) | undefined
let raceStarted = Promise.resolve()
let raceReleased = Promise.resolve()
function beginRace(): void {
  holdRace = true
  raceStarted = new Promise<void>((resolve) => {
    raceStart = resolve
  })
  raceReleased = new Promise<void>((resolve) => {
    raceFinish = resolve
  })
}
function fixtureJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
const responder = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const rawBody = Buffer.concat(chunks).toString('utf8')
    const requestUrl = request.url || ''
    requests.push({
      method: request.method || '',
      url: requestUrl,
      authorization: String(request.headers.authorization || ''),
      body: rawBody
    })
    const url = new URL(requestUrl, responderOrigin)
    if (url.pathname.startsWith('/v1/orders/')) {
      const orderNo = decodeURIComponent(url.pathname.slice('/v1/orders/'.length))
      if (orderNo === 'fail') {
        fixtureJson(response, 422, { privateDetail: 'sensitive-upstream-error' })
        return
      }
      fixtureJson(response, 200, { orderNo, customerId: 'cust-01' })
      return
    }
    if (url.pathname === '/v1/customers/cust-01') {
      fixtureJson(response, 200, { name: '示例客户' })
      return
    }
    if (url.pathname === '/v1/quote/preview') {
      const input: unknown = JSON.parse(rawBody)
      if (!isObjectRecord(input) || typeof input.weight !== 'number') {
        fixtureJson(response, 400, { privateDetail: 'bad quote' })
        return
      }
      fixtureJson(response, 200, { amount: input.weight * 4, echo: request.headers.authorization })
      return
    }
    if (url.pathname === '/v1/quote/race') {
      if (holdRace) {
        raceStart?.()
        await raceReleased
      }
      if (!response.destroyed) fixtureJson(response, 200, { amount: 88 })
      return
    }
    fixtureJson(response, 404, { privateDetail: 'unknown upstream route' })
  })().catch(() => {
    if (!response.destroyed) fixtureJson(response, 500, { privateDetail: 'fixture failed' })
  })
})
function record(value: unknown): Record<string, unknown> {
  assert.ok(isObjectRecord(value))
  return value
}
function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value) && value.every(isObjectRecord))
  return value
}
function safe(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const forbidden of [
    secret,
    rotatedSecret,
    'ciphertext',
    'sensitive-upstream-error',
    'privateDetail',
    'accessToken'
  ])
    assert.ok(!serialized.includes(forbidden), 'response leaked private material')
}
function transientDatabaseError(value: unknown): boolean {
  if (!isObjectRecord(value)) return false
  const detail = `${String(value.message || '')} ${String(value.details || '')}`
  return /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(detail)
}
/** Recover only explicit-ID fixture INSERTs after a lost response; never replay business calls. */
async function seedRows(
  table: string,
  rowsToSeed: Record<string, unknown>[],
  key: string,
  tenantId?: string
): Promise<void> {
  let missing = rowsToSeed
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await database.from(table).insert(missing).select(key)
    if (!inserted.error) return
    if (!transientDatabaseError(inserted.error)) requireData(inserted)
    let confirmed = false
    for (let check = 0; check < 3; check += 1) {
      let query = database
        .from(table)
        .select(tenantId ? `${key},tenant_id` : key)
        .in(
          key,
          rowsToSeed.map((row) => row[key])
        )
      if (tenantId) query = query.eq('tenant_id', tenantId)
      const current = await query
      if (current.error) {
        if (transientDatabaseError(current.error)) continue
        requireData(current)
      }
      const present = rows(requireData(current)).map((item) => String(item[key]))
      missing = rowsToSeed.filter((row) => !present.includes(String(row[key])))
      confirmed = true
      if (!missing.length) return
      break
    }
    if (!confirmed || attempt === 2) requireData(inserted)
  }
}
async function api(
  index: number,
  route: string,
  method = 'GET',
  payload?: unknown,
  overrides: Record<string, string> = {}
): Promise<{ status: number; body: unknown; requestId: string }> {
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
  const text = await response.text()
  const output = {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    requestId: response.headers.get('X-Request-Id') || ''
  }
  safe(output.body)
  return output
}
async function expectGatewayOk(
  label: string,
  result: { status: number; body: unknown; requestId: string },
  startedAt: number,
  beforeOutbound: number
): Promise<void> {
  if (result.status === 200) return
  const call = await database
    .from('bff_interface_calls')
    .select('status,error_code,http_status,duration_ms,steps,started_at,finished_at')
    .eq('request_id', result.requestId)
    .eq('tenant_id', tenantA)
    .maybeSingle()
  throw new Error(
    `${label} gateway diagnostic: ${JSON.stringify({
      status: result.status,
      code: isObjectRecord(result.body) ? result.body.code : null,
      elapsedMs: Date.now() - startedAt,
      outbound: requests
        .slice(beforeOutbound)
        .map((item) => ({ method: item.method, url: item.url })),
      call: call.error ? { errorCode: call.error.code } : call.data
    })}`
  )
}
async function createApp(actor: string, code: string): Promise<string> {
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
async function createUpstream(
  index: number,
  applicationId: string,
  code: string,
  credential?: string
): Promise<Record<string, unknown>> {
  const created = await api(index, '/api/upstreams', 'POST', {
    applicationId,
    code,
    name: code,
    description: '发布联调',
    environment: 'development',
    baseUrl: `${responderOrigin}/v1`,
    authType: credential ? 'bearer' : 'none',
    headerName: credential ? 'Authorization' : '',
    timeoutMs: 5000,
    ...(credential ? { credential } : {})
  })
  assert.equal(created.status, 201)
  const row = record(created.body)
  const active = await api(index, `/api/upstreams/${row.id}/status`, 'POST', {
    status: 'active',
    version: row.version
  })
  assert.equal(active.status, 200)
  return record(active.body)
}
async function createInterface(
  index: number,
  value: InterfaceWriteInput
): Promise<Record<string, unknown>> {
  const created = await api(index, '/api/interfaces', 'POST', value)
  assert.equal(created.status, 201)
  return record(created.body)
}
function quoteDefinition(appId: string, upstreamId: string): InterfaceWriteInput {
  const base = interfaceFixture(appId, upstreamId)
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
async function validateAndTest(
  id: string,
  version: number,
  input: Record<string, unknown>
): Promise<void> {
  const validated = await api(0, `/api/interfaces/${id}/validate`, 'POST', { version })
  assert.equal(validated.status, 200)
  assert.equal(record(validated.body).validationStatus, 'valid')
  const tested = await api(0, `/api/interfaces/${id}/tests`, 'POST', { version, input })
  assert.equal(tested.status, 200)
  assert.equal(record(tested.body).passed, true)
}
async function publish(
  id: string,
  draftVersion: number,
  deploymentVersion: number
): Promise<Record<string, unknown>> {
  const ready = await api(0, `/api/releases/${id}/readiness?purpose=publish`)
  assert.equal(ready.status, 200)
  assert.equal(record(ready.body).ready, true, JSON.stringify(record(ready.body).checks))
  const result = await api(0, `/api/releases/${id}/publish`, 'POST', {
    draftVersion,
    deploymentVersion,
    notes: '合成发布回归'
  })
  if (result.status !== 200) {
    const history = await api(0, `/api/releases/${id}/history`)
    const current =
      isObjectRecord(history.body) && isObjectRecord(history.body.record)
        ? history.body.record
        : null
    throw new Error(
      `Publish failed without automatic retry: ${JSON.stringify({
        status: result.status,
        code: isObjectRecord(result.body) ? result.body.code : null,
        message: isObjectRecord(result.body) ? result.body.message : null,
        historyStatus: history.status,
        versionCount: current?.versionCount ?? null,
        deployment: current?.deployment ?? null
      })}`
    )
  }
  return record(result.body)
}
function deployment(history: Record<string, unknown>): Record<string, unknown> {
  return record(record(history.record).deployment)
}
function firstVersion(history: Record<string, unknown>): Record<string, unknown> {
  return rows(history.versions)[0]
}
async function run(): Promise<void> {
  if (existsSync(manifest))
    throw new Error('An earlier upstream fixture manifest requires cleanup first')
  responder.listen(33441, '127.0.0.1')
  await once(responder, 'listening')
  mkdirSync(path.dirname(manifest), { recursive: true })
  writeFileSync(manifest, JSON.stringify({ tenantIds: [tenantA, tenantB], memberIds }), 'utf8')
  let runError: unknown, cleanupError: unknown
  try {
    await seedRows(
      'bff_members',
      memberIds.map((id, index) => ({
        id,
        issuer: config.issuer,
        subject: `bff-upstream-fixture:${id}`,
        tenant_id: index === 2 ? tenantB : tenantA,
        role: index === 1 ? 'viewer' : 'admin',
        email: `bff-release-fixture-${index}@example.test`,
        display_name: `Release HTTP ${index}`
      })),
      'id'
    )
    await seedRows(
      'bff_sessions',
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
      })),
      'token_hash'
    )
    const appA = await createApp(adminA, 'http-release-a')
    const appB = await createApp(adminB, 'http-release-b')
    const grant = await database.rpc('bff_set_application_member', {
      p_actor: adminA,
      p_application: appA,
      p_member: viewerA,
      p_granted: true
    })
    assert.equal(grant.error, null)
    const pageId = randomUUID(),
      roleId = randomUUID(),
      invokeId = randomUUID()
    await seedRows(
      'bff_menus',
      [
        {
          id: pageId,
          tenant_id: tenantA,
          name: 'FixtureReleaseHttp',
          type: 'menu',
          path: '/fixture-release-http',
          component: '/bff/releases/index',
          meta: { title: 'Release fixture', isEnable: true },
          create_by: adminA,
          update_by: adminA
        },
        {
          id: invokeId,
          tenant_id: tenantA,
          parent_id: pageId,
          name: 'BffInterface:Invoke',
          type: 'button',
          path: '',
          component: '',
          meta: { title: 'Invoke', isEnable: true },
          create_by: adminA,
          update_by: adminA
        }
      ],
      'id',
      tenantA
    )
    await seedRows(
      'bff_roles',
      [
        {
          id: roleId,
          tenant_id: tenantA,
          role_code: 'FixtureReleaseHttpReader',
          role_name: 'Release fixture caller',
          create_by: adminA,
          update_by: adminA
        }
      ],
      'id',
      tenantA
    )
    await seedRows(
      'bff_member_roles',
      [{ tenant_id: tenantA, member_id: viewerA, role_id: roleId, create_by: adminA }],
      'member_id',
      tenantA
    )
    assert.equal((await fetch(`${bffOrigin}/api/health`)).status, 200)

    const serviceA = await createUpstream(0, appA, 'release-orders')
    const serviceQuote = await createUpstream(0, appA, 'release-quote', secret)
    const serviceB = await createUpstream(2, appB, 'release-foreign')
    const orderInput = interfaceFixture(appA, String(serviceA.id))
    orderInput.definition.inputs.push({
      key: 'include',
      label: '范围',
      location: 'query',
      type: 'string',
      required: true
    })
    orderInput.definition.steps[0].query.push(inputBinding('include'))
    const order = await createInterface(0, orderInput)
    const quoteInput = quoteDefinition(appA, String(serviceQuote.id))
    const quote = await createInterface(0, quoteInput)
    const foreignInput = interfaceFixture(appB, String(serviceB.id))
    foreignInput.code = 'foreign-preview'
    foreignInput.path = '/foreign/{orderId}'
    const foreign = await createInterface(2, foreignInput)
    const orderId = String(order.id),
      quoteId = String(quote.id)
    const beforePublished = requests.length
    const unpublished = await api(
      0,
      '/api/gateway/http-release-a/development/orders/ORDER%201?include=customer'
    )
    assert.equal(unpublished.status, 404)
    assert.equal(requests.length, beforePublished)
    assert.equal(
      (
        await api(1, `/api/releases/${orderId}/publish`, 'POST', {
          draftVersion: 1,
          deploymentVersion: 0,
          notes: 'denied'
        })
      ).status,
      403
    )
    assert.equal((await api(0, `/api/releases/${foreign.id}/history`)).status, 404)
    assert.equal(
      (
        await api(0, `/api/releases/${orderId}/publish`, 'POST', {
          draftVersion: 1,
          deploymentVersion: 0,
          notes: 'unready'
        })
      ).status,
      409
    )
    await validateAndTest(orderId, 1, { orderId: 'ORDER 1', include: 'customer' })
    const first = await publish(orderId, 1, 0)
    assert.equal(deployment(first).version, 1)
    const versionOne = firstVersion(first)
    assert.equal(versionOne.number, 1)
    assert.equal(
      (
        await api(0, `/api/releases/${orderId}/publish`, 'POST', {
          draftVersion: 1,
          deploymentVersion: 0,
          notes: 'stale'
        })
      ).status,
      409
    )
    const gatewayPath = '/api/gateway/http-release-a/development/orders/ORDER%201?include=customer'
    const beforeGateway = requests.length
    assert.equal((await api(1, gatewayPath)).status, 403)
    assert.equal(requests.length, beforeGateway)
    await seedRows(
      'bff_role_menus',
      [{ tenant_id: tenantA, role_id: roleId, menu_id: invokeId, create_by: adminA }],
      'menu_id',
      tenantA
    )
    const firstGatewayStarted = Date.now()
    const called = await api(1, gatewayPath)
    await expectGatewayOk('first published', called, firstGatewayStarted, beforeGateway)
    assert.match(called.requestId, /^[0-9a-f-]{36}$/i)
    assert.deepEqual(record(called.body).data, { orderNo: 'ORDER 1', customerName: '示例客户' })
    assert.equal(record(called.body).requestId, called.requestId)
    assert.equal(record(called.body).version, 1)
    assert.equal(requests.length, beforeGateway + 2)
    assert.equal(requests.at(-2)?.url, '/v1/orders/ORDER%201?include=customer')
    assert.equal(requests.at(-1)?.url, '/v1/customers/cust-01')
    const deniedCount = requests.length
    const crossTenant = await api(2, gatewayPath)
    assert.equal(
      crossTenant.status,
      404,
      JSON.stringify({
        code: isObjectRecord(crossTenant.body) ? crossTenant.body.code : null,
        message: isObjectRecord(crossTenant.body) ? crossTenant.body.message : null,
        outbound: requests.length - deniedCount
      })
    )
    assert.equal((await api(1, `${gatewayPath}&unexpected=1`)).status, 400)
    assert.equal((await api(1, `${gatewayPath}&include=duplicate`)).status, 400)
    assert.equal(
      (await api(1, '/api/gateway/http-release-a/development/orders/%2F?include=customer')).status,
      400
    )
    assert.equal(requests.length, deniedCount)

    const changed = structuredClone(orderInput)
    changed.definition.outputs.push(stepBinding('customerId', 'order', '/customerId'))
    const updated = await api(0, `/api/interfaces/${orderId}`, 'PUT', { ...changed, version: 1 })
    assert.equal(updated.status, 200)
    assert.equal(record(updated.body).version, 2)
    const beforeDraftGateway = requests.length
    const draftGatewayStarted = Date.now()
    const stillV1 = await api(1, gatewayPath)
    await expectGatewayOk('draft isolation', stillV1, draftGatewayStarted, beforeDraftGateway)
    assert.equal(record(stillV1.body).version, 1)
    assert.deepEqual(record(stillV1.body).data, { orderNo: 'ORDER 1', customerName: '示例客户' })
    await new Promise((resolve) => setTimeout(resolve, 5200))
    await validateAndTest(orderId, 2, { orderId: 'ORDER 1', include: 'customer' })
    const second = await publish(orderId, 2, 1)
    assert.equal(deployment(second).version, 2)
    const v2 = await api(1, gatewayPath)
    assert.equal(v2.status, 200)
    assert.equal(record(v2.body).version, 2)
    assert.deepEqual(record(v2.body).data, {
      orderNo: 'ORDER 1',
      customerName: '示例客户',
      customerId: 'cust-01'
    })
    const rollback = await api(0, `/api/releases/${orderId}/rollback`, 'POST', {
      targetVersionId: versionOne.id,
      deploymentVersion: 2,
      notes: '合成回滚回归'
    })
    assert.equal(rollback.status, 200)
    assert.equal(deployment(record(rollback.body)).version, 3)
    assert.equal(record((await api(1, gatewayPath)).body).version, 1)
    const disabled = await api(0, `/api/releases/${orderId}/status`, 'POST', {
      enabled: false,
      deploymentVersion: 3,
      notes: '合成停用'
    })
    assert.equal(disabled.status, 200)
    const stoppedCount = requests.length
    assert.equal((await api(1, gatewayPath)).status, 404)
    assert.equal(requests.length, stoppedCount)
    const versionTwo = rows(second.versions).find((item) => item.number === 2)
    assert.ok(versionTwo)
    const rolledWhileDisabled = await api(0, `/api/releases/${orderId}/rollback`, 'POST', {
      targetVersionId: versionTwo.id,
      deploymentVersion: 4,
      notes: '停用时切换已发布版本'
    })
    assert.equal(rolledWhileDisabled.status, 200)
    assert.equal(deployment(record(rolledWhileDisabled.body)).enabled, false)
    assert.equal((await api(1, gatewayPath)).status, 404)
    assert.equal(requests.length, stoppedCount)
    const enabled = await api(0, `/api/releases/${orderId}/status`, 'POST', {
      enabled: true,
      deploymentVersion: 5,
      notes: '合成启用'
    })
    assert.equal(enabled.status, 200)
    assert.equal(record((await api(1, gatewayPath)).body).version, 2)

    await validateAndTest(quoteId, 1, { weight: 12.5 })
    const publishedQuote = await publish(quoteId, 1, 0)
    assert.equal(deployment(publishedQuote).version, 1)
    const quoteRoute = '/api/gateway/http-release-a/development/quote/preview'
    const beforeWrite = requests.length
    const idempotencyKey = randomUUID()
    assert.equal(
      (await api(1, quoteRoute, 'POST', { weight: 12.5 }, { 'Idempotency-Key': idempotencyKey }))
        .status,
      403
    )
    assert.equal((await api(0, quoteRoute, 'POST', { weight: 12.5 })).status, 400)
    assert.equal(
      (
        await api(
          0,
          quoteRoute,
          'POST',
          { weight: 12.5 },
          { 'Idempotency-Key': idempotencyKey, Origin: 'https://forged.example' }
        )
      ).status,
      403
    )
    assert.equal(
      (
        await api(
          0,
          quoteRoute,
          'POST',
          { weight: 12.5 },
          { 'Idempotency-Key': idempotencyKey, 'X-CSRF-Token': 'wrong' }
        )
      ).status,
      403
    )
    assert.equal(
      (
        await api(
          0,
          quoteRoute,
          'POST',
          { weight: 12.5, unknown: true },
          { 'Idempotency-Key': idempotencyKey }
        )
      ).status,
      400
    )
    assert.equal(requests.length, beforeWrite)
    const written = await api(
      0,
      quoteRoute,
      'POST',
      { weight: 12.5 },
      { 'Idempotency-Key': idempotencyKey }
    )
    assert.equal(written.status, 200)
    assert.deepEqual(record(written.body).data, { amount: 50 })
    assert.equal(requests.length, beforeWrite + 1)
    assert.equal(requests.at(-1)?.authorization, `Bearer ${secret}`)
    const replay = await api(
      0,
      quoteRoute,
      'POST',
      { weight: 12.5 },
      { 'Idempotency-Key': idempotencyKey }
    )
    assert.equal(replay.status, 200)
    assert.deepEqual(replay.body, written.body)
    assert.equal(replay.requestId, written.requestId)
    assert.equal(requests.length, beforeWrite + 1)
    const conflicting = await api(
      0,
      quoteRoute,
      'POST',
      { weight: 13 },
      { 'Idempotency-Key': idempotencyKey }
    )
    assert.equal(conflicting.status, 409)
    assert.equal(requests.length, beforeWrite + 1)
    const failed = await api(
      0,
      quoteRoute,
      'POST',
      { weight: 1 },
      { 'Idempotency-Key': randomUUID() }
    )
    assert.equal(failed.status, 200)
    assert.deepEqual(record(failed.body).data, { amount: 4 })
    const failureStart = requests.length
    const upstreamFailed = await api(
      1,
      '/api/gateway/http-release-a/development/orders/fail?include=customer'
    )
    if (upstreamFailed.status !== 502) {
      const call = await database
        .from('bff_interface_calls')
        .select('status,error_code,error_class,http_status,steps')
        .eq('request_id', upstreamFailed.requestId)
        .eq('tenant_id', tenantA)
        .maybeSingle()
      throw new Error(
        `Expected safe upstream failure: ${JSON.stringify({
          httpStatus: upstreamFailed.status,
          code: isObjectRecord(upstreamFailed.body) ? upstreamFailed.body.code : null,
          requestId: upstreamFailed.requestId,
          outboundDelta: requests.length - failureStart,
          call: call.error ? { errorCode: call.error.code } : call.data
        })}`
      )
    }
    assert.equal(requests.length, failureStart + 1)
    assert.ok(typeof record(upstreamFailed.body).requestId === 'string')

    const raceInput = quoteDefinition(appA, String(serviceQuote.id))
    raceInput.code = 'freight-race'
    raceInput.name = '并发请求预览'
    raceInput.path = '/quote/race'
    raceInput.definition.steps[0].path = '/quote/race'
    const raceRecord = await createInterface(0, raceInput)
    const raceId = String(raceRecord.id)
    await validateAndTest(raceId, 1, { weight: 1 })
    await publish(raceId, 1, 0)
    beginRace()
    const raceKey = randomUUID()
    const raceCount = requests.length
    const raceRoute = '/api/gateway/http-release-a/development/quote/race'
    const raceStartedAt = Date.now()
    const running = api(0, raceRoute, 'POST', { weight: 2 }, { 'Idempotency-Key': raceKey })
    await Promise.race([
      raceStarted,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Gateway race did not start')), 15_000).unref()
      )
    ])
    const duplicate = await api(0, raceRoute, 'POST', { weight: 2 }, { 'Idempotency-Key': raceKey })
    assert.equal(duplicate.status, 202)
    assert.equal(record(duplicate.body).code, 'IN_PROGRESS')
    assert.equal(requests.length, raceCount + 1)
    raceFinish?.()
    holdRace = false
    const raceResult = await running
    if (raceResult.status !== 200) {
      const call = await database
        .from('bff_interface_calls')
        .select('status,error_code,error_class,http_status,duration_ms,steps')
        .eq('request_id', raceResult.requestId)
        .eq('tenant_id', tenantA)
        .maybeSingle()
      throw new Error(
        `Expected idempotent original success: ${JSON.stringify({
          elapsedMs: Date.now() - raceStartedAt,
          httpStatus: raceResult.status,
          code: isObjectRecord(raceResult.body) ? raceResult.body.code : null,
          requestId: raceResult.requestId,
          duplicateStatus: duplicate.status,
          call: call.error ? { errorCode: call.error.code } : call.data
        })}`
      )
    }
    assert.equal(duplicate.requestId, raceResult.requestId)
    const raceReplay = await api(
      0,
      raceRoute,
      'POST',
      { weight: 2 },
      { 'Idempotency-Key': raceKey }
    )
    assert.equal(raceReplay.status, 200)
    assert.equal(raceReplay.requestId, raceResult.requestId)
    assert.equal(requests.length, raceCount + 1)
    beginRace()
    const changedKey = randomUUID()
    const beforeRotation = requests.length
    const rotatingCall = api(0, raceRoute, 'POST', { weight: 3 }, { 'Idempotency-Key': changedKey })
    await Promise.race([
      raceStarted,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Gateway rotation race did not start')), 15_000).unref()
      )
    ])
    const rotation = await api(0, `/api/upstreams/${serviceQuote.id}/credential`, 'PUT', {
      action: 'rotate',
      version: serviceQuote.version,
      credential: rotatedSecret
    })
    assert.equal(rotation.status, 200)
    raceFinish?.()
    holdRace = false
    const uncertain = await rotatingCall
    assert.equal(uncertain.status, 409)
    assert.equal(record(uncertain.body).code, 'RESULT_UNKNOWN')
    assert.equal(record(uncertain.body).requestId, uncertain.requestId)
    assert.equal(requests.length, beforeRotation + 1)
    const noRetry = await api(
      0,
      raceRoute,
      'POST',
      { weight: 3 },
      { 'Idempotency-Key': changedKey }
    )
    assert.equal(noRetry.status, 409)
    assert.equal(record(noRetry.body).code, 'RESULT_UNKNOWN')
    assert.equal(requests.length, beforeRotation + 1)
    const sourceRefs = await api(0, `/api/upstreams/${serviceA.id}/references`)
    assert.equal(sourceRefs.status, 200)
    assert.ok(
      rows(sourceRefs.body).some(
        (row) => row.sourceTable === 'bff_interface_versions' && row.targetId === orderId
      )
    )
    assert.equal(
      (await api(0, `/api/upstreams/${serviceA.id}`, 'DELETE', { version: serviceA.version }))
        .status,
      409
    )
    const list = await api(0, '/api/releases?size=20')
    assert.equal(list.status, 200)
    assert.ok(Number(record(list.body).total) >= 2)
    assert.equal((await api(1, `/api/releases/${orderId}/history`)).status, 403)
    console.log(
      'Release HTTP checks passed: two published definitions, immutable versions, rollback, disable/enable, gateway authorization, strict input and idempotent write replay.'
    )
  } catch (error) {
    runError = error
  } finally {
    raceFinish?.()
    responder.closeAllConnections()
    await new Promise<void>((resolve) => responder.close(() => resolve()))
    try {
      execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-File',
          'scripts/supabase-management.ps1',
          '-Action',
          'CleanupUpstreamFixtures'
        ],
        { cwd: process.cwd(), timeout: 120_000, stdio: 'pipe' }
      )
      console.log('Synthetic release HTTP fixtures removed.')
    } catch (error) {
      cleanupError = error
    }
  }
  if (runError || cleanupError)
    throw new AggregateError(
      [...(runError ? [runError] : []), ...(cleanupError ? [cleanupError] : [])],
      'Release HTTP verification failed'
    )
}
await run()
