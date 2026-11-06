/** Real BFF API/database authorization checks. Synthetic records are removed in finally.
 * This verifies server sessions and authorization; it does not simulate a completed OAuth login.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { database, requireData } from '../../server/database/client'
import { config } from '../../server/config'
import { digest, opaqueToken, seal } from '../../server/security'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type { ApplicationList, BffApplication } from '../../src/types/bff'

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
function applicationList(value: unknown): ApplicationList {
  assert.ok(isObjectRecord(value))
  assert.ok(Array.isArray(value.records))
  assert.ok(
    typeof value.total === 'number' &&
      typeof value.current === 'number' &&
      typeof value.size === 'number'
  )
  const records = value.records.map((row: unknown): BffApplication => {
    assert.ok(isObjectRecord(row))
    assert.deepEqual(Object.keys(row).sort(), [
      'code',
      'createdAt',
      'description',
      'enabled',
      'homeUrl',
      'id',
      'name',
      'updatedAt',
      'version'
    ])
    assert.ok(
      typeof row.id === 'string' && typeof row.code === 'string' && typeof row.name === 'string'
    )
    assert.ok(typeof row.description === 'string' && typeof row.homeUrl === 'string')
    assert.ok(typeof row.enabled === 'boolean' && typeof row.version === 'number')
    assert.ok(typeof row.createdAt === 'string' && typeof row.updatedAt === 'string')
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      homeUrl: row.homeUrl,
      enabled: row.enabled,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  })
  return { records, total: value.total, current: value.current, size: value.size }
}
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
  const own = applicationList((await api(0, '/api/applications')).body),
    foreign = applicationList((await api(1, '/api/applications')).body)
  assert.equal(own.records.length, 1)
  assert.equal(foreign.records.length, 1)
  const app = own.records[0],
    foreignApp = foreign.records[0]
  assert.equal(applicationList((await api(2, '/api/applications')).body).total, 0)
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
  const visible = applicationList(
    (
      await api(2, '/api/applications', 'GET', undefined, {
        'x-art-tenant-scope': tenantB
      })
    ).body
  )
  assert.equal(visible.records.length, 1)
  assert.equal(visible.records[0].id, app.id)
  assert.equal(
    (await api(0, `/api/applications/${app.id}`, 'PUT', { ...input, version: 999 })).status,
    409
  )
  assert.equal(
    (await api(0, `/api/applications/${app.id}/members/${viewer}`, 'PUT', { granted: false }))
      .status,
    200
  )
  assert.equal(applicationList((await api(2, '/api/applications')).body).total, 0)
  // Real HTTP transport and transaction checks for the shared control-plane pages.
  assert.equal((await api(2, '/api/control/menus')).status, 403)
  assert.equal((await api(2, '/api/control/dictionaries')).status, 403)
  assert.equal((await api(2, '/api/control/dictionaries?options=1')).status, 200)
  assert.deepEqual(await api(0, '/api/control/table-columns?routePath=%2Fdata-center%2Fdict'), {
    status: 200,
    body: { enabled: false, catalog: null, profiles: [] }
  })
  assert.equal(
    (await api(2, '/api/control/table-columns?routePath=%2Fdata-center%2Fdict')).status,
    403
  )
  assert.equal((await api(0, '/api/control/table-columns?routePath=unknown')).status, 404)
  const definitions = [
    {
      name: 'IntegrationMenuA',
      type: 'menu',
      path: '/integration-a',
      component: '/bff/applications/index',
      meta: { title: '测试入口一' },
      sort: 1
    },
    {
      name: 'IntegrationMenuB',
      type: 'menu',
      path: '/integration-b',
      component: '/bff/applications/index',
      meta: { title: '测试入口二' },
      sort: 2
    }
  ]
  for (const [index, definition] of definitions.entries()) {
    const response = await api(0, '/api/control/menus', 'POST', {
      operation: 'create',
      revision: index + 1,
      definition
    })
    assert.equal(response.status, 200)
  }
  const menuResponse = await api(0, '/api/control/menus', 'GET', undefined, {
    'x-art-tenant-scope': tenantB
  })
  assert.equal(menuResponse.status, 200)
  assert.ok(isObjectRecord(menuResponse.body) && Array.isArray(menuResponse.body.records))
  assert.equal(menuResponse.body.records.length, 2)
  const menu = menuResponse.body.records[0]
  assert.ok(isObjectRecord(menu) && typeof menu.id === 'string')
  assert.equal(
    (
      await api(2, '/api/control/menus', 'POST', {
        operation: 'create',
        revision: 3,
        definition: definitions[0]
      })
    ).status,
    403
  )
  assert.equal(
    (
      await api(
        0,
        '/api/control/menus',
        'POST',
        { operation: 'create', revision: 3, definition: definitions[0] },
        { 'X-CSRF-Token': 'forged' }
      )
    ).status,
    403
  )
  assert.equal(
    (
      await api(1, '/api/control/menus', 'POST', {
        operation: 'update',
        revision: 1,
        definition: menu
      })
    ).status,
    404
  )
  const conflicting = await Promise.all(
    [1, 2].map(() =>
      api(0, '/api/control/menus', 'POST', { operation: 'update', revision: 3, definition: menu })
    )
  )
  assert.deepEqual(conflicting.map((response) => response.status).sort(), [200, 409])
  const navigation = await api(0, '/api/auth/session')
  assert.ok(isObjectRecord(navigation.body) && Array.isArray(navigation.body.menu))
  assert.equal(navigation.body.menu.length, 2)
  const unique = await api(1, '/api/control/unique', 'POST', {
    table: 'sys_menu',
    field: 'name',
    value: definitions[0].name
  })
  assert.deepEqual(unique, { status: 200, body: { taken: false } })
  const ownUnique = await api(0, '/api/control/unique', 'POST', {
    table: 'sys_menu',
    field: 'name',
    value: definitions[0].name
  })
  assert.deepEqual(ownUnique, { status: 200, body: { taken: true } })
  const menuIds = menuResponse.body.records.map((row: unknown) => {
    assert.ok(isObjectRecord(row) && typeof row.id === 'string')
    return row.id
  })
  assert.equal(
    (await api(0, '/api/control/menus', 'POST', { operation: 'delete', revision: 3, ids: menuIds }))
      .status,
    409
  )
  assert.equal(
    (await api(0, '/api/control/menus', 'POST', { operation: 'delete', revision: 4, ids: menuIds }))
      .status,
    200
  )

  const typeResponse = await api(0, '/api/control/dictionary-types', 'POST', {
    operation: 'create',
    revision: 1,
    definition: {
      nodeType: 'dictionary',
      name: '隔离测试环境',
      code: 'integrationEnvironment',
      status: '1'
    }
  })
  assert.equal(typeResponse.status, 200)
  assert.ok(isObjectRecord(typeResponse.body) && typeof typeResponse.body.id === 'string')
  const typeId = typeResponse.body.id
  for (const [index, value] of ['development', 'production'].entries()) {
    assert.equal(
      (
        await api(0, '/api/control/dictionary-items', 'POST', {
          operation: 'create',
          revision: index + 2,
          definition: {
            typeId,
            label: value === 'development' ? '开发' : '生产',
            value,
            status: '1'
          }
        })
      ).status,
      200
    )
  }
  const dicts = await api(0, '/api/control/dictionaries')
  assert.ok(isObjectRecord(dicts.body) && Array.isArray(dicts.body.items))
  assert.equal(dicts.body.items.length, 2)
  const dictionaryItem = dicts.body.items[0]
  assert.ok(isObjectRecord(dictionaryItem))
  assert.equal(
    (
      await api(0, '/api/control/dictionary-items', 'POST', {
        operation: 'update',
        revision: 4,
        definition: { ...dictionaryItem, status: '2' }
      })
    ).status,
    200
  )
  const options = await api(2, '/api/control/dictionaries?options=1')
  assert.ok(isObjectRecord(options.body) && Array.isArray(options.body.items))
  assert.equal(options.body.items.length, 1)
  const historical = await api(
    2,
    `/api/control/dictionary-display?${new URLSearchParams({ code: 'integrationEnvironment', value: String(dictionaryItem.value) })}`
  )
  assert.equal(historical.status, 200)
  assert.ok(Array.isArray(historical.body) && isObjectRecord(historical.body[0]))
  assert.equal(historical.body[0].status, '2')
  const dependencies = await api(0, '/api/control/references', 'POST', {
    resourceType: 'dict_type',
    ids: [typeId]
  })
  assert.equal(dependencies.status, 200)
  assert.ok(Array.isArray(dependencies.body))
  assert.equal(dependencies.body.length, 2)
  assert.equal(
    (
      await api(0, '/api/control/dictionary-types', 'POST', {
        operation: 'delete',
        revision: 5,
        ids: [typeId]
      })
    ).status,
    409
  )
  const dictionaryIds = dicts.body.items.map((row: unknown) => {
    assert.ok(isObjectRecord(row) && typeof row.id === 'string')
    return row.id
  })
  assert.equal(
    (
      await api(0, '/api/control/dictionary-items', 'POST', {
        operation: 'delete',
        revision: 5,
        ids: dictionaryIds
      })
    ).status,
    200
  )
  assert.equal(
    (
      await api(0, '/api/control/dictionary-types', 'POST', {
        operation: 'delete',
        revision: 6,
        ids: [typeId]
      })
    ).status,
    200
  )
  console.log(
    'Shared menu/dictionary HTTP checks passed: two records, atomic conflicting edits, dynamic navigation, scoped uniqueness, disabled history, references and deletion.'
  )
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
    'bff_dictionary_items',
    'bff_dictionary_types',
    'bff_menus',
    'bff_applications',
    'bff_members'
  ]) {
    const column =
      table === 'bff_sessions' || table === 'bff_application_members'
        ? 'member_id'
        : table === 'bff_audit_events'
          ? 'actor_id'
          : ['bff_dictionary_items', 'bff_dictionary_types', 'bff_menus'].includes(table)
            ? 'create_by'
            : table === 'bff_applications'
              ? 'created_by'
              : 'id'
    const result = await database.from(table).delete().in(column, members)
    if (result.error)
      cleanupErrors.push(
        new Error(`Synthetic integration cleanup failed for ${table}`, { cause: result.error })
      )
  }
  const revisions = await database
    .from('bff_resource_revisions')
    .delete()
    .in('tenant_id', [tenantA, tenantB])
  if (revisions.error)
    cleanupErrors.push(new Error('Synthetic revision cleanup failed', { cause: revisions.error }))
  if (!cleanupErrors.length) console.log('Synthetic integration records removed.')
}

if (verificationError || cleanupErrors.length)
  throw new AggregateError(
    [...(verificationError ? [verificationError] : []), ...cleanupErrors],
    'BFF integration verification failed'
  )
