/** Real BFF API/database authorization checks. Synthetic records are removed in finally.
 * This verifies server sessions and authorization; it does not simulate a completed OAuth login.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { database, requireData } from '../../server/database/client'
import { config } from '../../server/config'
import { digest, opaqueToken, seal } from '../../server/security'

assert.equal(new URL(config.databaseUrl).hostname, 'bksbwnxdurmuolygiofh.supabase.co')
const origin = process.env.BFF_TEST_ORIGIN || 'http://localhost:3012'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
const tenantA = randomUUID(),
  tenantB = randomUUID(),
  adminA = randomUUID(),
  adminB = randomUUID(),
  viewer = randomUUID()
const members = [adminA, adminB, viewer],
  csrf = 'synthetic-integration-csrf'
const tokens = members.map(() => opaqueToken())
async function api(
  index: number,
  route: string,
  method = 'GET',
  input?: unknown,
  extra: Record<string, string> = {}
) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: {
      Cookie: `bff_session=${tokens[index]}`,
      Origin: origin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
      ...extra
    },
    ...(input ? { body: JSON.stringify(input) } : {})
  })
  return { status: response.status, body: await response.json() }
}
let verificationError: unknown
const cleanupErrors: Error[] = []
try {
  requireData(
    await database
      .from('bff_members')
      .insert(
        members.map((id, index) => ({
          id,
          issuer: config.issuer,
          subject: id,
          tenant_id: index === 1 ? tenantB : tenantA,
          role: index === 2 ? 'viewer' : 'admin',
          display_name: '隔离集成验证'
        }))
      )
      .select('id')
  )
  requireData(
    await database
      .from('bff_sessions')
      .insert(
        members.map((id, index) => ({
          token_hash: digest(tokens[index]),
          member_id: id,
          csrf_token: csrf,
          expires_at: new Date(Date.now() + 600000).toISOString(),
          payload: seal(
            {
              accessToken: 'synthetic-not-an-oauth-token',
              refreshToken: '',
              expiresAt: Date.now() + 600000,
              subject: id
            },
            config.sessionKey
          )
        }))
      )
      .select('token_hash')
  )
  for (const [returnTo, expected] of [
    ['/applications?name=test', '/applications?name=test'],
    ['//evil.example', '/applications'],
    ['/auth/login', '/applications']
  ]) {
    const entry = await fetch(`${origin}/api/auth/login?${new URLSearchParams({ returnTo })}`, {
      redirect: 'manual',
      headers: { Cookie: `bff_session=${tokens[0]}` }
    })
    assert.equal(entry.status, 303)
    assert.equal(entry.headers.get('location'), expected)
  }
  const input = {
    code: 'integration-app',
    name: '隔离集成应用',
    description: '',
    homeUrl: '',
    enabled: true
  }
  assert.equal(
    (await api(0, '/api/applications', 'POST', { ...input, tenantId: tenantB })).status,
    201
  )
  assert.equal((await api(1, '/api/applications', 'POST', input)).status, 201)
  const own = await api(0, '/api/applications'),
    foreign = await api(1, '/api/applications')
  assert.equal(own.body.records.length, 1)
  assert.equal(foreign.body.records.length, 1)
  const app = own.body.records[0],
    foreignApp = foreign.body.records[0]
  assert.equal((await api(2, '/api/applications')).body.total, 0)
  assert.equal((await api(2, '/api/applications', 'POST', input)).status, 403)
  assert.equal(
    (await api(0, `/api/applications/${foreignApp.id}`, 'PUT', { ...input, version: 1 })).status,
    409
  )
  assert.equal(
    (await api(0, '/api/applications', 'POST', input, { 'X-CSRF-Token': 'forged' })).status,
    403
  )
  assert.equal(
    (await api(0, '/api/applications', 'POST', input, { Origin: 'https://evil.example' })).status,
    403
  )
  assert.equal(
    (await api(0, `/api/applications/${app.id}/members/${adminB}`, 'PUT', { granted: true }))
      .status,
    403
  )
  assert.equal(
    (await api(0, `/api/applications/${app.id}/members/${viewer}`, 'PUT', { granted: true }))
      .status,
    200
  )
  const visible = await api(2, '/api/applications', 'GET', undefined, {
    'x-art-tenant-scope': tenantB
  })
  assert.equal(visible.body.records.length, 1)
  assert.equal(visible.body.records[0].id, app.id)
  assert.equal(
    (await api(0, `/api/applications/${app.id}`, 'PUT', { ...input, version: 999 })).status,
    409
  )
  assert.equal(
    (await api(0, `/api/applications/${app.id}/members/${viewer}`, 'PUT', { granted: false }))
      .status,
    200
  )
  assert.equal((await api(2, '/api/applications')).body.total, 0)
  requireData(
    await database.from('bff_members').update({ enabled: false }).eq('id', viewer).select('id')
  )
  assert.equal((await api(2, '/api/auth/session')).status, 403)
  assert.equal((await api(2, '/api/auth/logout', 'POST', {})).status, 200)
  assert.equal((await api(2, '/api/auth/session')).status, 401)
  const anonymous = await fetch(`${origin}/api/applications`)
  assert.equal(anonymous.status, 401)
  console.log(
    'Real BFF API checks passed: tenant isolation, forged scope, viewer denial, CSRF, grants, stale edits and logout.'
  )
} catch (error) {
  verificationError = error
} finally {
  for (const table of [
    'bff_sessions',
    'bff_application_members',
    'bff_audit_events',
    'bff_applications',
    'bff_members'
  ]) {
    const column =
      table === 'bff_sessions' || table === 'bff_application_members'
        ? 'member_id'
        : table === 'bff_audit_events'
          ? 'actor_id'
          : table === 'bff_applications'
            ? 'created_by'
            : 'id'
    const result = await database.from(table).delete().in(column, members)
    if (result.error)
      cleanupErrors.push(
        new Error(`Synthetic integration cleanup failed for ${table}`, { cause: result.error })
      )
  }
  if (!cleanupErrors.length) console.log('Synthetic integration records removed.')
}

if (verificationError || cleanupErrors.length)
  throw new AggregateError(
    [...(verificationError ? [verificationError] : []), ...cleanupErrors],
    'BFF integration verification failed'
  )
