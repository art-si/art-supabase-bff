/** Scoped HTTP verification for call logs and alert lifecycle. Never touches pro Auth. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config } from '../../server/config'
import { database, requireData } from '../../server/database/client'
import { digest, opaqueToken, seal } from '../../server/security'

assert.equal(new URL(config.databaseUrl).hostname, 'bksbwnxdurmuolygiofh.supabase.co')
const origin = process.env.BFF_TEST_ORIGIN || 'http://localhost:3012'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
const manifest = path.resolve('.artifacts/upstream-http-fixtures.json')
const tenantA = randomUUID(),
  tenantB = randomUUID(),
  adminA = randomUUID(),
  viewerA = randomUUID(),
  adminB = randomUUID(),
  appId = randomUUID(),
  interfaceId = randomUUID(),
  versionId = randomUUID()
const memberIds = [adminA, viewerA, adminB]
const tokens = memberIds.map(() => opaqueToken())
const csrf = `bff-observability-http-${randomUUID()}`
const privateMarker = `synthetic-private-${randomUUID()}`

function object(value: unknown): Record<string, unknown> {
  assert.ok(isObjectRecord(value))
  return value
}
function objects(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value) && value.every(isObjectRecord))
  return value
}
function list(value: unknown): Record<string, unknown>[] {
  return objects(object(value).records)
}
function noPrivateMaterial(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const forbidden of [
    privateMarker,
    'inputHash',
    'input_hash',
    'idempotencyHash',
    'idempotency_hash',
    'resultPayload',
    'result_payload',
    'accessToken'
  ])
    assert.ok(!serialized.includes(forbidden), `HTTP response exposed ${forbidden}`)
}
async function seed(table: string, values: Record<string, unknown>[], key: string): Promise<void> {
  let missing = values
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const inserted = await database.from(table).insert(missing).select(key)
    if (!inserted.error) return
    if (!/fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(inserted.error.message))
      requireData(inserted)
    const confirmed = await database
      .from(table)
      .select(key)
      .in(
        key,
        values.map((item) => item[key])
      )
    const present = new Set(objects(requireData(confirmed)).map((item) => String(item[key])))
    missing = values.filter((item) => !present.has(String(item[key])))
    if (!missing.length) return
    if (attempt === 2) requireData(inserted)
  }
}
async function api(
  actor: number,
  route: string,
  method = 'GET',
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      Cookie: `bff_session=${tokens[actor]}`,
      Origin: origin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
      ...headers
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  })
  const raw = await response.text()
  const output = { status: response.status, body: raw ? JSON.parse(raw) : null }
  noPrivateMaterial(output.body)
  return output
}
function callRow(requestId: string, status: 'succeeded' | 'failed', marker: string) {
  return {
    request_id: requestId,
    tenant_id: tenantA,
    application_id: appId,
    environment: 'development',
    interface_id: interfaceId,
    version_id: versionId,
    member_id: adminA,
    deployment_version: 1,
    method: 'GET',
    path_template: '/orders/{orderId}',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: status === 'failed' ? 5000 : 45,
    status,
    http_status: status === 'failed' ? 502 : 200,
    error_code: status === 'failed' ? 'UPSTREAM_FAILED' : null,
    error_class: status === 'failed' ? 'timeout' : null,
    steps: [
      {
        key: 'fetchOrder',
        status: status === 'failed' ? 'failed' : 'passed',
        statusCode: status === 'failed' ? null : 200,
        durationMs: status === 'failed' ? 5000 : 45,
        code: status === 'failed' ? 'TIMEOUT' : null,
        errorClass: status === 'failed' ? 'timeout' : null
      }
    ],
    idempotency_hash: null,
    input_hash: digest(`${privateMarker}:${marker}`),
    result_payload: null
  }
}

async function cleanup(): Promise<void> {
  for (const table of ['bff_alert_instances', 'bff_alert_rules']) {
    const removed = await database.from(table).delete().eq('tenant_id', tenantA)
    if (removed.error)
      throw new Error(`Synthetic ${table} cleanup failed`, { cause: removed.error })
  }
  execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      'scripts/supabase-management.ps1',
      '-Action',
      'CleanupUpstreamFixtures'
    ],
    {
      cwd: process.cwd(),
      timeout: 120_000,
      stdio: 'pipe'
    }
  )
}

async function run(): Promise<void> {
  if (existsSync(manifest)) throw new Error('Earlier isolated fixture manifest requires cleanup')
  mkdirSync(path.dirname(manifest), { recursive: true })
  writeFileSync(manifest, JSON.stringify({ tenantIds: [tenantA, tenantB], memberIds }), 'utf8')
  let runError: unknown, cleanupError: unknown
  try {
    await seed(
      'bff_members',
      memberIds.map((id, index) => ({
        id,
        issuer: config.issuer,
        subject: `bff-upstream-fixture:${id}`,
        tenant_id: index === 2 ? tenantB : tenantA,
        role: index === 1 ? 'viewer' : 'admin',
        email: `observability-${index}@example.test`,
        display_name: `Observability Fixture ${index}`
      })),
      'id'
    )
    await seed(
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
    await seed(
      'bff_applications',
      [
        {
          id: appId,
          tenant_id: tenantA,
          code: 'observability-fixture',
          name: '观测验收应用',
          created_by: adminA,
          updated_by: adminA
        }
      ],
      'id'
    )
    const definition = {
      inputs: [
        { key: 'orderId', label: '订单号', location: 'path', type: 'string', required: true }
      ],
      steps: [
        {
          key: 'fetchOrder',
          name: '查询订单',
          upstreamId: randomUUID(),
          configVersion: 1,
          method: 'GET',
          path: '/orders/{orderId}',
          pathParams: [],
          query: [],
          body: []
        }
      ],
      outputs: [{ target: 'status', source: 'literal', literalType: 'string', literalValue: 'ok' }]
    }
    await seed(
      'bff_interfaces',
      [
        {
          id: interfaceId,
          tenant_id: tenantA,
          application_id: appId,
          environment: 'development',
          code: 'order-lookup',
          name: '订单查询',
          method: 'GET',
          path: '/orders/{orderId}',
          definition,
          created_by: adminA,
          updated_by: adminA
        }
      ],
      'id'
    )
    await seed(
      'bff_interface_versions',
      [
        {
          id: versionId,
          interface_id: interfaceId,
          tenant_id: tenantA,
          application_id: appId,
          environment: 'development',
          number: 1,
          draft_version: 1,
          code: 'order-lookup',
          name: '订单查询',
          description: '',
          method: 'GET',
          path: '/orders/{orderId}',
          definition,
          checksum: digest(JSON.stringify(definition)),
          notes: '隔离观测验收',
          created_by: adminA
        }
      ],
      'id'
    )
    const successId = randomUUID(),
      failureId = randomUUID(),
      recoveryId = randomUUID()
    await seed(
      'bff_interface_calls',
      [callRow(successId, 'succeeded', 'success'), callRow(failureId, 'failed', 'timeout')],
      'request_id'
    )

    const callList = await api(0, '/api/calls?size=20')
    assert.equal(callList.status, 200, JSON.stringify(callList.body))
    assert.equal(list(callList.body).length, 2)
    assert.equal((await api(0, '/api/calls/options')).status, 200)
    const detail = await api(0, `/api/calls/${failureId}`)
    assert.equal(detail.status, 200)
    assert.equal(object(detail.body).errorClass, 'timeout')
    assert.equal((await api(1, '/api/calls')).status, 403)
    assert.equal((await api(2, `/api/calls/${failureId}`)).status, 404)
    assert.equal((await api(2, '/api/calls')).status, 200)
    assert.equal(list((await api(2, '/api/calls')).body).length, 0)

    const failureRule = {
      applicationId: appId,
      environment: 'development',
      interfaceId,
      name: '失败率观察',
      metric: 'failure_rate',
      windowMinutes: 5,
      threshold: 50,
      minCalls: 2,
      severity: 'warning',
      enabled: true,
      quietMinutes: 0
    }
    const timeoutRule = {
      ...failureRule,
      name: '超时观察',
      metric: 'timeout_count',
      threshold: 1,
      minCalls: 1,
      severity: 'critical'
    }
    assert.equal(
      (await api(0, '/api/alerts/rules', 'POST', failureRule, { 'X-CSRF-Token': '' })).status,
      403
    )
    const createdFailure = await api(0, '/api/alerts/rules', 'POST', failureRule)
    const createdTimeout = await api(0, '/api/alerts/rules', 'POST', timeoutRule)
    assert.equal(createdFailure.status, 201)
    assert.equal(createdTimeout.status, 201)
    const failureRuleId = String(object(createdFailure.body).id)
    const timeoutRuleId = String(object(createdTimeout.body).id)
    assert.equal(list((await api(0, '/api/alerts/rules')).body).length, 2)
    assert.equal((await api(0, '/api/alerts/options')).status, 200)
    assert.equal((await api(1, '/api/alerts/rules')).status, 403)
    assert.equal(
      (await api(2, `/api/alerts/rules/${failureRuleId}/evaluate`, 'POST', {})).status,
      404
    )
    assert.equal(
      (await api(0, `/api/alerts/rules/${failureRuleId}/evaluate`, 'POST', {})).status,
      200
    )
    assert.equal(
      (await api(0, `/api/alerts/rules/${timeoutRuleId}/evaluate`, 'POST', {})).status,
      200
    )
    const open = list((await api(0, '/api/alerts?state=open')).body)
    assert.equal(open.length, 2)
    const failureAlert = open.find((item) => item.ruleId === failureRuleId)
    const timeoutAlert = open.find((item) => item.ruleId === timeoutRuleId)
    assert.ok(failureAlert && timeoutAlert)
    assert.equal((await api(2, `/api/alerts/${failureAlert.id}`)).status, 404)
    const ack = await api(0, `/api/alerts/${failureAlert.id}/ack`, 'POST', {
      version: failureAlert.version
    })
    assert.equal(ack.status, 200)
    assert.equal(object(ack.body).state, 'acknowledged')
    assert.equal(
      (
        await api(0, `/api/alerts/${failureAlert.id}/ack`, 'POST', {
          version: failureAlert.version
        })
      ).status,
      409
    )

    await seed('bff_interface_calls', [callRow(recoveryId, 'succeeded', 'recovery')], 'request_id')
    const recovery = await api(0, `/api/alerts/rules/${failureRuleId}/evaluate`, 'POST', {})
    assert.equal(recovery.status, 200)
    assert.equal(object((await api(0, `/api/alerts/${failureAlert.id}`)).body).state, 'recovered')
    const status = await api(0, `/api/alerts/rules/${timeoutRuleId}/status`, 'POST', {
      version: 1,
      enabled: false
    })
    assert.equal(status.status, 200)
    assert.equal(object((await api(0, `/api/alerts/${timeoutAlert.id}`)).body).state, 'closed')
    assert.equal(
      (
        await api(0, `/api/alerts/rules/${timeoutRuleId}/status`, 'POST', {
          version: 1,
          enabled: true
        })
      ).status,
      409
    )
    const archived = await api(0, `/api/alerts/rules/${timeoutRuleId}/archive`, 'POST', {
      version: 2
    })
    assert.equal(archived.status, 200)
    assert.ok(object(archived.body).archivedAt)
    const updated = await api(0, `/api/alerts/rules/${failureRuleId}`, 'PUT', {
      ...failureRule,
      version: 1,
      name: '失败率观察已调整',
      quietMinutes: 5
    })
    assert.equal(updated.status, 200)
    assert.equal(object(updated.body).version, 2)
    console.log(
      'Observability HTTP checks passed: three scoped calls, two rules, trigger, acknowledge, recover, archive, CAS, role, tenant and CSRF.'
    )
  } catch (error) {
    runError = error
  } finally {
    try {
      await cleanup()
      console.log('Synthetic observability HTTP fixtures removed.')
    } catch (error) {
      cleanupError = error
    }
  }
  if (runError || cleanupError)
    throw new AggregateError(
      [...(runError ? [runError] : []), ...(cleanupError ? [cleanupError] : [])],
      'Observability HTTP verification failed'
    )
}

await run()
