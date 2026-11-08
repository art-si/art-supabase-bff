/** Real Edge-factory to BFF gateway workflow with synthetic Pro subjects and local upstreams only.
 * Run serially after the canonical bridge schema is applied on the isolated preview host.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import path from 'node:path'
import { createBffGatewayHandler } from 'art-supabase-pro/supabase/functions/_shared/bff-gateway-handler.ts'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config } from '../../server/config'
import { database, requireData } from '../../server/database/client'
import { digest, opaqueToken, seal } from '../../server/security'
import type { InterfaceWriteInput } from '../../src/types/interface'

assert.equal(new URL(config.databaseUrl).hostname, 'bksbwnxdurmuolygiofh.supabase.co')
const bffOrigin = process.env.BFF_TEST_ORIGIN || 'http://localhost:3012'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(bffOrigin).hostname))
const responderOrigin = 'http://127.0.0.1:33445'
const proOrigin = 'http://localhost:3006'
const manifest = path.resolve('.artifacts/upstream-http-fixtures.json')
const tenantA = randomUUID(),
  tenantB = randomUUID()
const adminA = randomUUID(),
  adminB = randomUUID()
const memberIds = [adminA, adminB]
const cookieTokens = [opaqueToken(), opaqueToken()]
const edgeTokens = [`synthetic-pro-token-${randomUUID()}`, `synthetic-pro-token-${randomUUID()}`]
const csrf = 'bff-bridge-http-fixture-csrf'
const privateMarker = `private-provider-${randomUUID()}`
let javaFail = false
let seenUpstream = 0
let capturedAssertion = ''
let capturedBody = ''
let forwardedAuthorization = false

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(value))
}
const responder = createServer((req, res) => {
  seenUpstream++
  if (req.headers.authorization || req.headers.cookie) forwardedAuthorization = true
  const url = new URL(req.url || '/', responderOrigin)
  if (url.pathname === '/java') {
    if (javaFail) return json(res, 200, { code: 4001, msg: 'failure', data: { privateMarker } })
    return json(res, 200, {
      code: 0,
      msg: 'ok',
      data: {
        records: [
          { id: 'java-1', name: 'Java甲', privateMarker },
          { id: 'java-2', name: 'Java乙', privateMarker }
        ],
        total: 2
      }
    })
  }
  if (url.pathname === '/supabase') {
    assert.equal(req.headers.prefer, 'count=exact')
    assert.equal(url.searchParams.get('offset'), '0')
    assert.equal(url.searchParams.get('limit'), '2')
    return json(
      res,
      200,
      [
        { id: 'sb-1', name: 'Supabase甲', privateMarker },
        { id: 'sb-2', name: 'Supabase乙', privateMarker }
      ],
      { 'Content-Range': '0-1/2' }
    )
  }
  if (url.pathname === '/cloudbase')
    return json(res, 200, {
      result: {
        code: 0,
        data: {
          list: [
            { id: 'cb-1', name: 'CloudBase甲', privateMarker },
            { id: 'cb-2', name: 'CloudBase乙', privateMarker }
          ],
          total: 2
        }
      }
    })
  json(res, 404, { privateMarker })
})

function record(value: unknown): Record<string, unknown> {
  assert.ok(isObjectRecord(value))
  return value
}
async function cookieApi(index: number, route: string, method = 'GET', payload?: unknown) {
  const response = await fetch(`${bffOrigin}${route}`, {
    method,
    headers: {
      Cookie: `bff_session=${cookieTokens[index]}`,
      Origin: bffOrigin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json'
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  })
  return { status: response.status, body: (await response.json()) as unknown }
}
function pageDefinition(
  applicationId: string,
  upstreamId: string,
  kind: 'java' | 'supabase' | 'cloudbase'
): InterfaceWriteInput {
  const endpoint = kind === 'java' ? '/java' : kind === 'supabase' ? '/supabase' : '/cloudbase'
  const contract =
    kind === 'java'
      ? { mode: 'business' as const, codePointer: '/code', dataPointer: '/data', successCodes: [0] }
      : kind === 'cloudbase'
        ? {
            mode: 'business' as const,
            codePointer: '/result/code',
            dataPointer: '/result/data',
            successCodes: [0]
          }
        : undefined
  const name = kind === 'java' ? 'Java列表' : kind === 'supabase' ? 'Supabase列表' : 'CloudBase列表'
  return {
    applicationId,
    environment: 'development',
    code: `bridge-${kind}`,
    name,
    description: '仅合成数据的响应规范化验收',
    method: 'GET',
    path: endpoint,
    definition: {
      inputs: [
        { key: 'current', label: '页码', location: 'query', type: 'number', required: true },
        { key: 'size', label: '页长', location: 'query', type: 'number', required: true }
      ],
      steps: [
        {
          key: 'load',
          name: '列表查询',
          upstreamId,
          configVersion: 1,
          method: 'GET',
          path: endpoint,
          pathParams: [],
          query: [],
          body: [],
          ...(contract ? { responseContract: contract } : {}),
          pagination: {
            mode: 'offset',
            currentInputKey: 'current',
            sizeInputKey: 'size',
            pageParameter: 'offset',
            sizeParameter: 'limit',
            exactCount: kind === 'supabase'
          }
        }
      ],
      outputs: [],
      page: {
        stepKey: 'load',
        recordsPointer: kind === 'java' ? '/records' : kind === 'cloudbase' ? '/list' : '',
        totalSource: kind === 'supabase' ? 'content-range' : 'body',
        totalPointer: kind === 'supabase' ? '' : '/total',
        currentInputKey: 'current',
        sizeInputKey: 'size',
        fields: [
          { target: 'id', label: '编号', pointer: '/id', type: 'string', required: true },
          { target: 'name', label: '名称', pointer: '/name', type: 'string', required: true }
        ]
      }
    }
  }
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
  assert.equal(typeof id, 'string')
  return id as string
}
async function upstream(
  applicationId: string,
  kind: 'java' | 'supabase' | 'cloudbase'
): Promise<string> {
  const created = await cookieApi(0, '/api/upstreams', 'POST', {
    applicationId,
    code: `bridge-source-${kind}`,
    name: `Bridge ${kind}`,
    description: '',
    environment: 'development',
    baseUrl: responderOrigin,
    authType: 'none',
    headerName: '',
    timeoutMs: 5000
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const row = record(created.body)
  const active = await cookieApi(0, `/api/upstreams/${row.id}/status`, 'POST', {
    status: 'active',
    version: row.version
  })
  assert.equal(active.status, 200, JSON.stringify(active.body))
  return String(row.id)
}
async function publish(input: InterfaceWriteInput): Promise<void> {
  const created = await cookieApi(0, '/api/interfaces', 'POST', input)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const row = record(created.body)
  const id = String(row.id)
  const validated = await cookieApi(0, `/api/interfaces/${id}/validate`, 'POST', {
    version: row.version
  })
  assert.equal(validated.status, 200, JSON.stringify(validated.body))
  assert.equal(record(validated.body).validationStatus, 'valid')
  const tested = await cookieApi(0, `/api/interfaces/${id}/tests`, 'POST', {
    version: row.version,
    input: { current: 1, size: 2 }
  })
  assert.equal(tested.status, 200, JSON.stringify(tested.body))
  assert.equal(record(tested.body).passed, true)
  const ready = await cookieApi(0, `/api/releases/${id}/readiness?purpose=publish`)
  assert.equal(ready.status, 200, JSON.stringify(ready.body))
  assert.equal(record(ready.body).ready, true)
  const released = await cookieApi(0, `/api/releases/${id}/publish`, 'POST', {
    draftVersion: row.version,
    deploymentVersion: 0,
    notes: '合成桥接验收'
  })
  assert.equal(released.status, 200, JSON.stringify(released.body))
}
const edge = createBffGatewayHandler({
  bffUrl: bffOrigin,
  bridgeSecret: config.proBridgeSecret,
  allowedOrigins: [proOrigin],
  allowLocalHttp: true,
  resolveUser: async (authorization: string) => {
    const index = edgeTokens.findIndex((token) => authorization === `Bearer ${token}`)
    return index < 0 ? null : { id: memberIds[index] }
  },
  fetcher: async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    capturedAssertion = headers.get('X-BFF-Pro-Assertion') || ''
    capturedBody = String(init?.body || '')
    assert.equal(headers.has('Authorization'), false)
    assert.equal(headers.has('Cookie'), false)
    return fetch(url, init)
  }
})
async function edgeApi(index: number, payload: unknown) {
  const response = await edge(
    new Request(`${proOrigin}/functions/v1/bff-gateway`, {
      method: 'POST',
      headers: {
        Origin: proOrigin,
        Authorization: `Bearer ${edgeTokens[index]}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  )
  return {
    status: response.status,
    body: (await response.json()) as unknown,
    requestId: response.headers.get('X-Request-Id') || ''
  }
}
function safe(value: unknown): Record<string, unknown> {
  const result = record(value)
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes(privateMarker))
  assert.ok(!serialized.includes('ciphertext') && !serialized.includes('keyId'))
  return result
}
async function run(): Promise<void> {
  if (existsSync(manifest))
    throw new Error('Another isolated HTTP fixture owns the cleanup manifest')
  assert.equal(Buffer.from(config.proBridgeSecret, 'base64').length, 32)
  mkdirSync(path.dirname(manifest), { recursive: true })
  responder.listen(33445, '127.0.0.1')
  await once(responder, 'listening')
  writeFileSync(manifest, JSON.stringify({ tenantIds: [tenantA, tenantB], memberIds }), 'utf8')
  try {
    requireData(
      await database
        .from('bff_members')
        .insert([
          {
            id: adminA,
            issuer: 'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',
            subject: adminA,
            tenant_id: tenantA,
            role: 'admin',
            enabled: true,
            display_name: 'bff-pro-bridge-fixture:adminA',
            email: 'admin-a@example.test'
          },
          {
            id: adminB,
            issuer: 'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',
            subject: adminB,
            tenant_id: tenantB,
            role: 'admin',
            enabled: true,
            display_name: 'bff-pro-bridge-fixture:adminB',
            email: 'admin-b@example.test'
          }
        ])
        .select('id')
    )
    requireData(
      await database
        .from('bff_sessions')
        .insert(
          memberIds.map((memberId, index) => ({
            token_hash: digest(cookieTokens[index]),
            member_id: memberId,
            payload: seal(
              {
                accessToken: 'synthetic',
                refreshToken: '',
                expiresAt: Date.now() + 3_600_000,
                subject: memberId
              },
              config.sessionKey
            ),
            csrf_token: csrf,
            expires_at: new Date(Date.now() + 3_600_000).toISOString()
          }))
        )
        .select('token_hash')
    )
    const nonceProbe = await database.rpc('bff_consume_pro_bridge_nonce', {
      p_actor: adminA,
      p_nonce_hash: digest(`fixture-nonce-${randomUUID()}`),
      p_expires_at: new Date(Date.now() + 45_000).toISOString()
    })
    if (nonceProbe.error)
      throw new Error(
        `Synthetic bridge nonce failed: ${nonceProbe.error.code || 'unknown'} / ${
          nonceProbe.error.message?.startsWith('BFF_') ? nonceProbe.error.message : 'database_error'
        }`
      )
    assert.equal(nonceProbe.data, true)
    const health = await fetch(`${bffOrigin}/api/health`)
    assert.equal(health.status, 200)
    const capabilities: unknown = await health.json()
    assert.ok(
      isObjectRecord(capabilities) &&
        Array.isArray(capabilities.capabilities) &&
        capabilities.capabilities.includes('pro-integration')
    )
    const applicationA = await app(adminA, 'bridge-http-a')
    const applicationB = await app(adminB, 'bridge-http-b')
    assert.ok(applicationB)
    console.log('bridge fixture: applications ready')
    for (const kind of ['java', 'supabase', 'cloudbase'] as const) {
      const upstreamId = await upstream(applicationA, kind)
      await publish(pageDefinition(applicationA, upstreamId, kind))
      console.log(`bridge fixture: ${kind} published`)
    }
    const catalog = await edgeApi(0, { operation: 'catalog' })
    console.log('bridge fixture: catalog requested')
    assert.equal(catalog.status, 200, JSON.stringify(catalog.body))
    const catalogRows = safe(catalog.body).records
    assert.ok(Array.isArray(catalogRows) && catalogRows.length === 3)
    assert.ok(catalogRows.every(isObjectRecord))
    assert.ok(
      catalogRows.every(
        (row) =>
          row.resultKind === 'page' &&
          isObjectRecord(row.pagination) &&
          row.pagination.currentInputKey === 'current'
      )
    )
    const foreignCatalog = await edgeApi(1, { operation: 'catalog' })
    assert.equal(foreignCatalog.status, 200)
    assert.deepEqual(safe(foreignCatalog.body).records, [])
    for (const kind of ['java', 'supabase', 'cloudbase'] as const) {
      const before = seenUpstream
      const invoked = await edgeApi(0, {
        operation: 'invoke',
        applicationCode: 'bridge-http-a',
        environment: 'development',
        path: `/${kind}`,
        method: 'GET',
        query: { current: 1, size: 2 },
        body: {}
      })
      assert.equal(invoked.status, 200, JSON.stringify(invoked.body))
      const response = safe(invoked.body)
      assert.equal(response.code, 200)
      assert.equal(response.msg, '成功')
      assert.equal(response.requestId, invoked.requestId)
      const data = record(response.data)
      assert.equal(data.total, 2)
      assert.equal(data.current, 1)
      assert.equal(data.size, 2)
      const rows = data.records
      assert.ok(Array.isArray(rows) && rows.length === 2)
      assert.ok(rows.every(isObjectRecord))
      assert.ok(rows.every((row) => Object.keys(row).sort().join(',') === 'id,name'))
      assert.equal(seenUpstream, before + 1)
    }
    javaFail = true
    const failed = await edgeApi(0, {
      operation: 'invoke',
      applicationCode: 'bridge-http-a',
      environment: 'development',
      path: '/java',
      method: 'GET',
      query: { current: 1, size: 2 },
      body: {}
    })
    assert.equal(failed.status, 502)
    assert.equal(safe(failed.body).code, 'UPSTREAM_FAILED')
    javaFail = false
    const crossTenant = await edgeApi(1, {
      operation: 'invoke',
      applicationCode: 'bridge-http-a',
      environment: 'development',
      path: '/java',
      method: 'GET',
      query: { current: 1, size: 2 },
      body: {}
    })
    assert.ok([403, 404].includes(crossTenant.status))
    safe(crossTenant.body)
    assert.ok(capturedAssertion && capturedBody)
    const replay = await fetch(`${bffOrigin}/api/integrations/pro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BFF-Pro-Assertion': capturedAssertion },
      body: capturedBody
    })
    assert.equal(replay.status, 409)
    assert.equal(safe(await replay.json()).code, 'BFF_BRIDGE_REPLAY')
    assert.equal(forwardedAuthorization, false)
  } finally {
    responder.closeAllConnections()
    await new Promise<void>((resolve) => responder.close(() => resolve()))
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-File',
        'scripts/supabase-management.ps1',
        '-Action',
        'CleanupUpstreamFixtures'
      ],
      { encoding: 'utf8', env: { ...process.env, NO_PROXY: 'localhost,127.0.0.1' } }
    )
    assert.match(output, /clean|fixture|清理/i)
  }
}
await run()
console.log(
  'Synthetic Pro Edge bridge, three response shapes, scoped catalog, replay and cleanup passed.'
)
