/** Real HTTP BFF upstream workflow with an isolated local responder and synthetic identities.
 * The fixture never authenticates with pro and never calls a user-configured upstream.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { database, requireData } from '../../server/database/client'
import { config } from '../../server/config'
import { decryptCredential } from '../../server/upstream-credentials'
import { upstreamKeys } from '../../server/upstream-runtime'
import { digest, opaqueToken, seal } from '../../server/security'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'

assert.equal(new URL(config.databaseUrl).hostname, 'bksbwnxdurmuolygiofh.supabase.co')
const bffOrigin = process.env.BFF_TEST_ORIGIN || 'http://localhost:3012'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(bffOrigin).hostname))
const fixtureOrigin = 'http://127.0.0.1:33441'
const manifest = path.resolve('.artifacts/upstream-http-fixtures.json')
const tenantA = randomUUID(),
  tenantB = randomUUID()
const adminA = randomUUID(),
  delegateA = randomUUID(),
  adminB = randomUUID()
const memberIds = [adminA, delegateA, adminB]
const tokens = memberIds.map(() => opaqueToken())
const csrf = 'bff-upstream-http-fixture-csrf'
const secretA = `fixture-key-${randomUUID()}`
const secretB = `fixture-key-${randomUUID()}`
let credentialHeaderObserved = false
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
function answer(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(body)
}
const fixture = createServer((req, res) => {
  if (req.headers.authorization || req.headers['x-api-key']) {
    credentialHeaderObserved = true
    answer(res, 500, 'unexpected authentication header')
    return
  }
  if (req.url === '/ok') answer(res, 200, 'fixture-ok')
  else if (req.url === '/redirect') {
    res.writeHead(302, { Location: `${fixtureOrigin}/ok` })
    res.end()
  } else if (req.url === '/large') answer(res, 200, 'x'.repeat(70 * 1024))
  else if (req.url === '/slow')
    setTimeout(() => {
      if (!res.destroyed) answer(res, 200, 'late')
    }, 1500)
  else if (req.url === '/race') {
    raceStarted?.()
    void raceReleasePromise.then(() => answer(res, 200, 'race-ok'))
  } else answer(res, 404, 'missing')
})
function record(value: unknown): Record<string, unknown> {
  assert.ok(isObjectRecord(value))
  return value
}
function rows(value: unknown): Record<string, unknown>[] {
  const values = record(value).records
  assert.ok(Array.isArray(values) && values.every(isObjectRecord))
  return values
}
async function api(
  index: number,
  route: string,
  method = 'GET',
  input?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${bffOrigin}${route}`, {
    method,
    headers: {
      Cookie: `bff_session=${tokens[index]}`,
      Origin: bffOrigin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
      ...headers
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  })
  return { status: response.status, body: await response.json() }
}
async function fixtureApplication(actor: string, code: string, enabled = true): Promise<string> {
  const result = await database.rpc('bff_save_application', {
    p_actor: actor,
    p_id: null,
    p_version: null,
    p_code: code,
    p_name: code,
    p_description: '',
    p_home_url: '',
    p_enabled: enabled
  })
  const id = record(requireData(result)).id
  assert.ok(typeof id === 'string')
  return id
}
function definition(
  applicationId: string,
  code: string,
  endpoint: string,
  authType: 'none' | 'bearer' = 'none',
  credential?: string
): Record<string, unknown> {
  return {
    applicationId,
    code,
    name: code,
    description: '受控联测数据',
    environment: 'development',
    baseUrl: `${fixtureOrigin}${endpoint}`,
    authType,
    headerName: authType === 'bearer' ? 'Authorization' : '',
    timeoutMs: endpoint === '/slow' ? 100 : 5000,
    ...(credential ? { credential } : {})
  }
}
async function createUpstream(
  index: number,
  input: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await api(index, '/api/upstreams', 'POST', input)
  assert.equal(response.status, 201, JSON.stringify(response.body))
  return record(response.body)
}
function publicSafe(value: unknown): void {
  const json = JSON.stringify(value)
  assert.ok(!json.includes(secretA) && !json.includes(secretB))
  assert.ok(!json.includes('ciphertext') && !json.includes('keyId'))
}
async function run(): Promise<void> {
  if (existsSync(manifest))
    throw new Error('An earlier upstream fixture manifest requires cleanup first')
  fixture.listen(33441, '127.0.0.1')
  await once(fixture, 'listening')
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
            email: `bff-upstream-fixture-${index}@example.test`,
            display_name: `Upstream HTTP ${index}`
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
    const appA = await fixtureApplication(adminA, 'http-upstream-a')
    const appAOther = await fixtureApplication(adminA, 'http-upstream-other')
    const appB = await fixtureApplication(adminB, 'http-upstream-b')
    const appGrant = await database.rpc('bff_set_application_member', {
      p_actor: adminA,
      p_application: appA,
      p_member: delegateA,
      p_granted: true
    })
    assert.equal(appGrant.error, null)
    const pageId = randomUUID(),
      roleId = randomUUID()
    requireData(
      await database
        .from('bff_menus')
        .insert([
          {
            id: pageId,
            tenant_id: tenantA,
            name: 'FixtureUpstreamHttp',
            type: 'menu',
            path: '/fixture-upstream-http',
            component: '/bff/upstreams/index',
            meta: { title: 'Upstream fixture' },
            create_by: adminA,
            update_by: adminA
          },
          ...(['View', 'Add', 'Edit'] as const).map((action) => ({
            id: randomUUID(),
            tenant_id: tenantA,
            parent_id: pageId,
            name: `BffUpstream:${action}`,
            type: 'button',
            path: '',
            component: '',
            meta: { title: action },
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
          role_code: 'FixtureUpstreamHttpReader',
          role_name: 'Upstream fixture reader',
          create_by: adminA,
          update_by: adminA
        })
        .select('id')
    )
    requireData(
      await database
        .from('bff_member_roles')
        .insert({ tenant_id: tenantA, member_id: delegateA, role_id: roleId, create_by: adminA })
        .select('member_id')
    )
    const buttons = requireData(
      await database.from('bff_menus').select('id').eq('tenant_id', tenantA).eq('parent_id', pageId)
    )
    requireData(
      await database
        .from('bff_role_menus')
        .insert(
          buttons.map(({ id }) => ({
            tenant_id: tenantA,
            role_id: roleId,
            menu_id: id,
            create_by: adminA
          }))
        )
        .select('menu_id')
    )
    const health = await fetch(`${bffOrigin}/api/health`)
    assert.equal(health.status, 200)
    const options = await api(0, '/api/upstreams/options')
    assert.equal(options.status, 200)
    assert.equal(record(options.body).credentialManagementReady, true)
    assert.equal(record(options.body).networkPolicyConfigured, true)
    assert.equal(rows({ records: record(options.body).applications }).length, 2)
    const viewerOptions = await api(1, '/api/upstreams/options')
    assert.equal(viewerOptions.status, 200)
    const viewerApps = record(viewerOptions.body).applications
    assert.ok(Array.isArray(viewerApps))
    assert.equal(viewerApps.length, 1)
    const first = await createUpstream(0, definition(appA, 'http-first', '/ok'))
    const second = await createUpstream(
      0,
      definition(appA, 'http-second', '/redirect', 'bearer', secretA)
    )
    const privateService = await createUpstream(0, definition(appAOther, 'http-private', '/large'))
    const foreignService = await createUpstream(2, definition(appB, 'http-foreign', '/slow'))
    for (const value of [first, second, privateService, foreignService]) publicSafe(value)
    const firstId = String(first.id),
      secondId = String(second.id),
      privateId = String(privateService.id)
    const listA = await api(0, '/api/upstreams?size=20')
    assert.equal(listA.status, 200)
    assert.equal(record(listA.body).total, 3)
    assert.equal(rows(listA.body).length, 3)
    assert.equal(record(rows(listA.body)[0].application).enabled, true)
    publicSafe(listA.body)
    assert.equal(record((await api(1, '/api/upstreams')).body).total, 2)
    assert.equal(record((await api(2, '/api/upstreams')).body).total, 1)
    assert.equal(
      record((await api(0, `/api/upstreams?recordId=${foreignService.id}`)).body).total,
      0
    )
    assert.equal(record((await api(0, `/api/upstreams?name=http-second`)).body).total, 1)
    assert.equal(
      (await api(1, '/api/upstreams', 'POST', definition(appAOther, 'forbidden-app', '/ok')))
        .status,
      403
    )
    assert.equal(
      (
        await api(1, `/api/upstreams/${privateId}/health-tests`, 'POST', {
          version: privateService.version
        })
      ).status,
      403
    )
    assert.equal(
      (await api(1, `/api/upstreams/${secondId}/health-tests`, 'POST', { version: second.version }))
        .status,
      403
    )
    assert.equal(
      (
        await api(0, '/api/upstreams', 'POST', definition(appA, 'forged-origin', '/ok'), {
          Origin: 'https://forged.example'
        })
      ).status,
      403
    )
    assert.equal(
      (
        await api(0, `/api/upstreams/${firstId}`, 'PUT', {
          ...definition(appA, 'http-first', '/ok'),
          version: 99
        })
      ).status,
      409
    )
    assert.equal(
      (
        await api(1, `/api/upstreams/${secondId}`, 'PUT', {
          ...definition(appA, 'http-second', '/ok', 'bearer'),
          version: second.version
        })
      ).status,
      403
    )
    const cipher = record(
      requireData(
        await database
          .from('bff_upstream_credentials')
          .select('ciphertext,key_id,credential_version')
          .eq('service_id', secondId)
          .single()
      )
    )
    assert.notEqual(cipher.ciphertext, secretA)
    assert.equal(
      decryptCredential(
        {
          ciphertext: String(cipher.ciphertext),
          keyId: String(cipher.key_id),
          version: Number(cipher.credential_version)
        },
        {
          tenantId: tenantA,
          applicationId: appA,
          serviceId: secondId,
          version: 1
        },
        upstreamKeys
      ),
      secretA
    )
    const edited = await api(0, `/api/upstreams/${secondId}`, 'PUT', {
      ...definition(appA, 'http-second', '/redirect', 'bearer'),
      name: '已更新服务',
      version: second.version
    })
    assert.equal(edited.status, 200, JSON.stringify(edited.body))
    assert.equal(record(edited.body).credentialVersion, 1)
    assert.equal(record(edited.body).credentialConfigured, true)
    const rotated = await api(0, `/api/upstreams/${secondId}/credential`, 'PUT', {
      action: 'rotate',
      version: record(edited.body).version,
      credential: secretB
    })
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body))
    assert.equal(record(rotated.body).credentialVersion, 2)
    const secondActive = await api(0, `/api/upstreams/${secondId}/status`, 'POST', {
      status: 'active',
      version: record(rotated.body).version
    })
    assert.equal(secondActive.status, 200, JSON.stringify(secondActive.body))
    assert.equal(
      (
        await api(0, `/api/upstreams/${secondId}/credential`, 'PUT', {
          action: 'clear',
          version: record(secondActive.body).version
        })
      ).status,
      409
    )
    const rotatedCipher = record(
      requireData(
        await database
          .from('bff_upstream_credentials')
          .select('ciphertext,key_id,credential_version')
          .eq('service_id', secondId)
          .single()
      )
    )
    assert.equal(
      decryptCredential(
        {
          ciphertext: String(rotatedCipher.ciphertext),
          keyId: String(rotatedCipher.key_id),
          version: Number(rotatedCipher.credential_version)
        },
        {
          tenantId: tenantA,
          applicationId: appA,
          serviceId: secondId,
          version: 2
        },
        upstreamKeys
      ),
      secretB
    )
    publicSafe(rotated.body)
    const activateFirst = await api(0, `/api/upstreams/${firstId}/status`, 'POST', {
      status: 'active',
      version: first.version
    })
    assert.equal(activateFirst.status, 200)
    assert.equal(
      (
        await api(0, `/api/upstreams/${firstId}`, 'PUT', {
          ...definition(appA, 'http-first', '/ok'),
          baseUrl: 'https://unlisted.example.test/endpoint',
          version: record(activateFirst.body).version
        })
      ).status,
      409
    )
    const stillAllowed = rows((await api(0, `/api/upstreams?recordId=${firstId}`)).body)
    assert.equal(stillAllowed.length, 1)
    assert.equal(stillAllowed[0].baseUrl, first.baseUrl)
    assert.equal((await api(0, `/api/upstreams/${firstId}/references`)).status, 200)
    assert.equal(
      (
        await api(0, `/api/upstreams/${firstId}`, 'DELETE', {
          version: record(activateFirst.body).version
        })
      ).status,
      409
    )
    const ok = await api(0, `/api/upstreams/${firstId}/health-tests`, 'POST', {
      version: record(activateFirst.body).version
    })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.equal(record(ok.body).healthStatus, 'reachable')
    assert.equal(record(ok.body).lastStatusCode, 200)
    const redirect = await api(0, `/api/upstreams/${secondId}/health-tests`, 'POST', {
      version: record(secondActive.body).version
    })
    assert.equal(redirect.status, 200, JSON.stringify(redirect.body))
    assert.equal(record(redirect.body).healthStatus, 'failed')
    assert.match(String(record(redirect.body).lastHealthMessage), /重定向/)
    const large = await api(0, `/api/upstreams/${privateId}/health-tests`, 'POST', {
      version: privateService.version
    })
    assert.equal(large.status, 200, JSON.stringify(large.body))
    assert.equal(record(large.body).healthStatus, 'failed')
    assert.match(String(record(large.body).lastHealthMessage), /响应超过/)
    const slowId = String(foreignService.id)
    const slow = await api(2, `/api/upstreams/${slowId}/health-tests`, 'POST', {
      version: foreignService.version
    })
    assert.equal(slow.status, 200, JSON.stringify(slow.body))
    assert.equal(record(slow.body).healthStatus, 'failed')
    assert.match(String(record(slow.body).lastHealthMessage), /超时/)
    const race = await createUpstream(0, definition(appA, 'http-race', '/race'))
    beginRace()
    const raceProbe = api(0, `/api/upstreams/${race.id}/health-tests`, 'POST', {
      version: race.version
    })
    await Promise.race([
      raceStartedPromise,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Controlled race probe did not start')), 15_000).unref()
      })
    ])
    const raceEdit = await api(0, `/api/upstreams/${race.id}`, 'PUT', {
      ...definition(appA, 'http-race', '/race'),
      name: '并发修改后',
      version: race.version
    })
    assert.equal(raceEdit.status, 200, JSON.stringify(raceEdit.body))
    raceRelease?.()
    const stale = await raceProbe
    assert.equal(stale.status, 200, JSON.stringify(stale.body))
    assert.equal(record(stale.body).probeStale, true)
    const disable = await api(0, `/api/upstreams/${secondId}/status`, 'POST', {
      status: 'disabled',
      version: record(secondActive.body).version
    })
    assert.equal(disable.status, 200)
    const clear = await api(0, `/api/upstreams/${secondId}/credential`, 'PUT', {
      action: 'clear',
      version: record(disable.body).version
    })
    assert.equal(clear.status, 200)
    assert.equal(record(clear.body).credentialConfigured, false)
    assert.equal(
      (
        await api(0, `/api/upstreams/${secondId}/status`, 'POST', {
          status: 'active',
          version: record(clear.body).version
        })
      ).status,
      409
    )
    const deleted = await api(0, `/api/upstreams/${secondId}`, 'DELETE', {
      version: record(clear.body).version
    })
    assert.equal(deleted.status, 200)
    assert.equal(record((await api(0, '/api/upstreams')).body).total, 3)
    assert.equal((await api(0, `/api/upstreams/${secondId}/references`)).status, 404)
    assert.equal(
      (await api(0, `/api/upstreams/${firstId}/health-tests`, 'POST', { version: first.version }))
        .status,
      409
    )
    const recovery = await createUpstream(
      0,
      definition(appA, 'http-key-recovery', '/ok', 'bearer', secretA)
    )
    const recoveryId = String(recovery.id)
    const recoveryCipher = record(
      requireData(
        await database
          .from('bff_upstream_credentials')
          .select('ciphertext')
          .eq('service_id', recoveryId)
          .single()
      )
    )
    const unknownKey = await database.rpc('bff_write_upstream', {
      p_actor: adminA,
      p_operation: 'credential',
      p_id: recoveryId,
      p_version: recovery.version,
      p_definition: null,
      p_credential: {
        ciphertext: recoveryCipher.ciphertext,
        keyId: 'unavailable-fixture-key',
        version: 2
      }
    })
    assert.equal(unknownKey.error, null)
    const unknownKeyVersion = record(unknownKey.data).version
    assert.equal(
      (
        await api(0, `/api/upstreams/${recoveryId}/status`, 'POST', {
          status: 'active',
          version: unknownKeyVersion
        })
      ).status,
      503
    )
    const missingKeyRow = rows((await api(0, `/api/upstreams?recordId=${recoveryId}`)).body)[0]
    assert.equal(missingKeyRow.status, 'draft')
    assert.equal(missingKeyRow.version, unknownKeyVersion)
    const corrupt = await database.rpc('bff_write_upstream', {
      p_actor: adminA,
      p_operation: 'credential',
      p_id: recoveryId,
      p_version: unknownKeyVersion,
      p_definition: null,
      p_credential: {
        ciphertext: 'invalid-ciphertext-value',
        keyId: upstreamKeys.activeId,
        version: 3
      }
    })
    assert.equal(corrupt.error, null)
    const corruptVersion = record(corrupt.data).version
    assert.equal(
      (
        await api(0, `/api/upstreams/${recoveryId}/status`, 'POST', {
          status: 'active',
          version: corruptVersion
        })
      ).status,
      503
    )
    const corruptRow = rows((await api(0, `/api/upstreams?recordId=${recoveryId}`)).body)[0]
    assert.equal(corruptRow.status, 'draft')
    assert.equal(corruptRow.version, corruptVersion)
    // AAD binds ciphertext to its version: recovery rotates instead of replaying version 1 bytes.
    const restored = await api(0, `/api/upstreams/${recoveryId}/credential`, 'PUT', {
      action: 'rotate',
      version: corruptVersion,
      credential: secretA
    })
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal(record(restored.body).credentialVersion, 4)
    assert.equal(
      (
        await api(0, `/api/upstreams/${recoveryId}/status`, 'POST', {
          status: 'active',
          version: record(restored.body).version
        })
      ).status,
      200
    )
    const audit = requireData(
      await database
        .from('bff_audit_events')
        .select('action,summary')
        .eq('tenant_id', tenantA)
        .like('action', 'upstream.%')
    )
    assert.ok(audit.length >= 8)
    assert.ok(!JSON.stringify(audit).includes(secretA) && !JSON.stringify(audit).includes(secretB))
    assert.equal(credentialHeaderObserved, false)
    console.log(
      'Upstream HTTP checks passed: tenant/app scope, encrypted credentials, CAS, probes, stale result, lifecycle and audit.'
    )
  } catch (error) {
    runError = error
  } finally {
    raceRelease?.()
    fixture.closeAllConnections()
    await new Promise<void>((resolve) => fixture.close(() => resolve()))
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
      console.log('Synthetic upstream HTTP fixtures removed.')
    } catch (error) {
      cleanupError = error
    }
  }
  if (runError || cleanupError)
    throw new AggregateError(
      [...(runError ? [runError] : []), ...(cleanupError ? [cleanupError] : [])],
      'Upstream HTTP verification failed'
    )
}
await run()
