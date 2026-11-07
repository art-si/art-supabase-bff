/** Run only after scoped BFF schema, private bucket and resource routes are provisioned. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config } from '../../server/config'
import { database } from '../../server/database/client'
import { runResourceCleanup } from '../../server/resources'
import { digest, opaqueToken, seal } from '../../server/security'
import { BFF_BRANDING_DEFAULTS } from '../../src/types/branding'
import { resourceDto } from '../../server/resources'
import type { BffResource } from '../../src/types/resource'

assert.equal(new URL(config.databaseUrl).hostname, 'bksbwnxdurmuolygiofh.supabase.co')
const origin = process.env.BFF_TEST_ORIGIN || 'http://localhost:3012'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
const manifest = path.resolve('.artifacts/resource-http-fixtures.json')
assert.ok(!existsSync(manifest), 'An earlier resource fixture needs cleanup first')
const tenants = [randomUUID(), randomUUID()]
const members = [randomUUID(), randomUUID(), randomUUID()]
const tokens = members.map(() => opaqueToken())
const csrf = 'bff-resource-http-fixture-csrf'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNVsAAAAASUVORK5CYII=',
  'base64'
)
const ico = readFileSync('node_modules/art-supabase-pro/src/assets/images/favicon.ico')

function row(value: unknown): Record<string, unknown> {
  assert.ok(isObjectRecord(value))
  return value
}
async function request(
  index: number,
  route: string,
  method = 'GET',
  input?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: unknown; headers: Headers }> {
  const response = await fetch(`${origin}${route}`, {
    method,
    signal: AbortSignal.timeout(60_000),
    headers: {
      Cookie: `bff_session=${tokens[index]}`,
      Origin: origin,
      'X-CSRF-Token': csrf,
      ...(input === undefined || input instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...headers
    },
    ...(input === undefined
      ? {}
      : { body: input instanceof FormData ? input : JSON.stringify(input) })
  })
  if (route.endsWith('/content') && response.ok)
    return {
      status: response.status,
      data: Buffer.from(await response.arrayBuffer()),
      headers: response.headers
    }
  return { status: response.status, data: await response.json(), headers: response.headers }
}
async function upload(
  index: number,
  name: string,
  bytes: Buffer,
  mime: string
): Promise<BffResource> {
  const form = new FormData()
  form.set('file', new File([Uint8Array.from(bytes)], name, { type: mime }))
  const startedAt = Date.now()
  let result: Awaited<ReturnType<typeof request>>
  try {
    result = await request(index, '/api/resources/upload', 'POST', form)
  } catch (error) {
    console.error('Isolated resource upload transport failed', {
      mime,
      sizeByte: bytes.length,
      elapsedMs: Date.now() - startedAt,
      kind: error instanceof Error ? error.name : 'UnknownError'
    })
    throw error
  }
  console.log('Isolated resource upload response', {
    mime,
    sizeByte: bytes.length,
    elapsedMs: Date.now() - startedAt,
    status: result.status
  })
  assert.equal(result.status, 201, JSON.stringify(result.data))
  const item = resourceDto(result.data)
  assert.ok(Number.isSafeInteger(item.id))
  assert.equal(item.url, `/api/resources/${item.id}/content`)
  assert.ok(
    !JSON.stringify(result.data).includes('objectKey') &&
      !JSON.stringify(result.data).includes('uploadToken')
  )
  return item
}
async function checked<T>(
  promise: PromiseLike<{ data: T | null; error: unknown }>
): Promise<T | null> {
  const result = await promise
  if (result.error) throw new Error('Fixture database operation failed', { cause: result.error })
  return result.data
}
async function cleanup(): Promise<void> {
  const resources = await checked(
    database
      .from('bff_resources')
      .select('storage_path,object_name,created_by')
      .in('tenant_id', tenants)
  )
  const rows = resources ?? []
  assert.ok(rows.every((item) => members.includes(item.created_by)))
  const keys = rows.map((item) => `${item.storage_path}/${item.object_name}`)
  if (keys.length) {
    const removed = await database.storage.from('bff-assets').remove(keys)
    if (removed.error && removed.error.statusCode !== '404')
      throw new Error('Fixture storage cleanup failed', { cause: removed.error })
  }
  await checked(database.from('bff_platform_settings').delete().in('tenant_id', tenants))
  await checked(database.from('bff_resources').delete().in('tenant_id', tenants))
  await checked(database.from('bff_audit_events').delete().in('tenant_id', tenants))
  await checked(database.from('bff_sessions').delete().in('member_id', members))
  await checked(database.from('bff_resource_revisions').delete().in('tenant_id', tenants))
  await checked(database.from('bff_members').delete().in('id', members))
  unlinkSync(manifest)
}

mkdirSync(path.dirname(manifest), { recursive: true })
writeFileSync(manifest, JSON.stringify({ tenantIds: tenants, memberIds: members }))
try {
  await checked(
    database.from('bff_members').insert(
      members.map((id, index) => ({
        id,
        issuer: config.issuer,
        subject: `bff-resource-fixture:${id}`,
        tenant_id: tenants[index === 2 ? 1 : 0],
        display_name: `Resource fixture ${index}`,
        email: `${id}@example.test`,
        role: index === 1 ? 'viewer' : 'admin',
        enabled: true
      }))
    )
  )
  await checked(
    database.from('bff_sessions').insert(
      members.map((id, index) => ({
        token_hash: digest(tokens[index]),
        member_id: id,
        payload: seal(
          {
            accessToken: 'synthetic',
            refreshToken: '',
            expiresAt: Date.now() + 3_600_000,
            subject: `bff-resource-fixture:${id}`
          },
          config.sessionKey
        ),
        csrf_token: csrf,
        expires_at: new Date(Date.now() + 3_600_000).toISOString()
      }))
    )
  )
  const first = await upload(0, 'logo.png', png, 'image/png')
  const second = await upload(0, 'favicon.ico', ico, 'image/x-icon')
  const foreignAsset = await upload(2, 'foreign.png', png, 'image/png')
  const list = await request(0, '/api/resources?from=0&to=29')
  assert.equal(list.status, 200)
  const listed = row(list.data).data
  assert.ok(Array.isArray(listed) && listed.length >= 2)
  assert.equal((await request(2, `/api/resources/${first.id}/content`)).status, 404)
  assert.equal((await request(1, '/api/resources?from=0&to=29')).status, 403)
  const content = await request(0, `/api/resources/${first.id}/content`)
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'image/png')
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(content.data, png)
  const iconContent = await request(0, `/api/resources/${second.id}/content`)
  assert.equal(iconContent.status, 200)
  assert.equal(iconContent.headers.get('content-type'), 'image/x-icon')
  assert.deepEqual(iconContent.data, ico)
  const badOrigin = await request(
    0,
    '/api/resources/upload',
    'POST',
    {},
    {
      Origin: 'https://outside.example.test'
    }
  )
  assert.equal(badOrigin.status, 403)
  const badCsrf = await request(
    0,
    `/api/resources/${second.id}/name`,
    'PUT',
    { version: second.version, originName: 'brand-favicon.ico' },
    { 'X-CSRF-Token': 'forged' }
  )
  assert.equal(badCsrf.status, 403)
  const viewerUpload = await request(1, '/api/resources/upload', 'POST', {})
  assert.equal(viewerUpload.status, 403)
  const renamed = await request(0, `/api/resources/${second.id}/name`, 'PUT', {
    version: second.version,
    originName: 'brand-favicon.ico'
  })
  assert.equal(renamed.status, 200)
  assert.equal(row(renamed.data).originName, 'brand-favicon.ico')
  assert.equal(
    (
      await request(0, `/api/resources/${second.id}/name`, 'PUT', {
        version: second.version,
        originName: 'brand-favicon-2.ico'
      })
    ).status,
    409
  )
  const branding = await request(0, '/api/control/branding')
  assert.equal(branding.status, 200)
  const brandSaved = await request(0, '/api/control/branding', 'POST', {
    version: row(branding.data).version,
    config: {
      ...BFF_BRANDING_DEFAULTS,
      logoUrl: first.url,
      faviconUrl: second.url,
      wordmarkImageEnabled: true,
      wordmarkLightUrl: first.url,
      wordmarkDarkUrl: first.url
    }
  })
  assert.equal(brandSaved.status, 200)
  const refs = await request(0, '/api/resources/references', 'POST', { ids: [first.id, second.id] })
  assert.equal(refs.status, 200)
  assert.ok(Array.isArray(refs.data) && refs.data.length === 4)
  assert.deepEqual(refs.data.map((item: unknown) => row(item).dependencyCode).sort(), [
    'faviconUrl',
    'logoUrl',
    'wordmarkDarkUrl',
    'wordmarkLightUrl'
  ])
  assert.equal(
    (await request(0, `/api/resources/${first.id}`, 'DELETE', { version: first.version })).status,
    409
  )
  assert.equal(
    (
      await request(0, `/api/resources/${second.id}`, 'DELETE', {
        version: row(renamed.data).version
      })
    ).status,
    409
  )
  const brandWithoutIcon = await request(0, '/api/control/branding', 'POST', {
    version: row(brandSaved.data).version,
    config: { ...BFF_BRANDING_DEFAULTS, logoUrl: first.url, faviconUrl: '' }
  })
  assert.equal(brandWithoutIcon.status, 200)
  const deleted = await request(0, `/api/resources/${second.id}`, 'DELETE', {
    version: row(renamed.data).version
  })
  assert.equal(deleted.status, 200)
  assert.equal((await request(0, `/api/resources/${second.id}/content`)).status, 404)
  const brandWithoutImages = await request(0, '/api/control/branding', 'POST', {
    version: row(brandWithoutIcon.data).version,
    config: {
      ...BFF_BRANDING_DEFAULTS,
      logoUrl: '',
      faviconUrl: '',
      wordmarkImageEnabled: false,
      wordmarkLightUrl: '',
      wordmarkDarkUrl: ''
    }
  })
  assert.equal(brandWithoutImages.status, 200)
  assert.equal(
    (await request(0, `/api/resources/${first.id}`, 'DELETE', { version: first.version })).status,
    200
  )
  const begun = await checked(
    database.rpc('bff_resource_delete_begin', {
      p_actor: members[2],
      p_id: foreignAsset.id,
      p_version: foreignAsset.version
    })
  )
  assert.ok(isObjectRecord(begun) && typeof begun.cleanupToken === 'string')
  await checked(
    database
      .from('bff_resources')
      .update({ cleanup_lease_until: new Date(Date.now() - 1000).toISOString() })
      .eq('id', foreignAsset.id)
  )
  await runResourceCleanup()
  const cleaned = await database
    .from('bff_resources')
    .select('status')
    .eq('id', foreignAsset.id)
    .single()
  assert.ifError(cleaned.error)
  assert.equal(cleaned.data?.status, 'deleted')
  console.log(
    'Resource HTTP checks passed: PNG and ICO, CRUD/CAS, four brand reference guards, tenant isolation, CSRF, private content, cleanup.'
  )
} finally {
  await cleanup()
}
