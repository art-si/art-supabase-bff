/** Real BFF branding API checks. Synthetic identities never call pro Auth. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config } from '../../server/config'
import { database, requireData } from '../../server/database/client'
import { digest, opaqueToken, seal } from '../../server/security'
import { BFF_BRANDING_DEFAULTS } from '../../src/types/branding'

assert.equal(new URL(config.databaseUrl).hostname, 'bksbwnxdurmuolygiofh.supabase.co')
const origin = process.env.BFF_TEST_ORIGIN || 'http://localhost:3012'
assert.ok(['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
const manifest = path.resolve('.artifacts/upstream-http-fixtures.json')
assert.ok(!existsSync(manifest), 'A previous isolated HTTP fixture must be cleaned first')
const tenants = [randomUUID(), randomUUID()]
const members = [randomUUID(), randomUUID(), randomUUID()]
const tokens = members.map(() => opaqueToken())
const csrf = 'branding-http-fixture'
const sample = { ...BFF_BRANDING_DEFAULTS, siteName: '示例：BFF运营平台', siteShortName: '运营BFF' }

async function api(
  index: number,
  endpoint: string,
  method = 'GET',
  input?: unknown,
  headers: Record<string, string> = {}
) {
  const response = await fetch(`${origin}${endpoint}`, {
    method,
    headers: {
      Cookie: `bff_session=${tokens[index]}`,
      Origin: origin,
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
      ...headers
    },
    ...(input ? { body: JSON.stringify(input) } : {})
  })
  const value: unknown = await response.json()
  assert.ok(isObjectRecord(value))
  return { status: response.status, data: value }
}

mkdirSync(path.dirname(manifest), { recursive: true })
writeFileSync(manifest, JSON.stringify({ tenantIds: tenants, memberIds: members }))
try {
  requireData(
    await database
      .from('bff_members')
      .insert(
        members.map((id, index) => ({
          id,
          issuer: config.issuer,
          subject: `bff-upstream-fixture:${id}`,
          tenant_id: tenants[index === 1 ? 1 : 0],
          display_name: `Branding fixture ${index}`,
          email: `${id}@example.test`,
          role: index === 2 ? 'viewer' : 'admin',
          enabled: true
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
          payload: seal(
            {
              accessToken: 'synthetic',
              refreshToken: '',
              expiresAt: Date.now() + 3600000,
              subject: `bff-upstream-fixture:${id}`
            },
            config.sessionKey
          ),
          csrf_token: csrf,
          expires_at: new Date(Date.now() + 3600000).toISOString()
        }))
      )
      .select('member_id')
  )
  const initial = await api(0, '/api/control/branding')
  assert.equal(initial.status, 200)
  assert.equal(initial.data.version, 0)
  const first = await api(0, '/api/control/branding', 'POST', { version: 0, config: sample })
  assert.equal(first.status, 200)
  assert.equal(first.data.version, 1)
  const reader = await api(2, '/api/control/branding')
  assert.equal(reader.status, 200)
  assert.deepEqual(reader.data.config, first.data.config)
  const foreign = await api(1, `/api/control/branding?tenant_id=${tenants[0]}`, 'GET', undefined, {
    'x-art-tenant-scope': tenants[0]
  })
  assert.equal(foreign.data.version, 0)
  assert.equal(
    (await api(2, '/api/control/branding', 'POST', { version: 1, config: sample })).status,
    403
  )
  assert.equal(
    (
      await api(
        0,
        '/api/control/branding',
        'POST',
        { version: 1, config: sample },
        { Origin: 'https://outside.example.test' }
      )
    ).status,
    403
  )
  assert.equal(
    (
      await api(
        0,
        '/api/control/branding',
        'POST',
        { version: 1, config: sample },
        { 'X-CSRF-Token': 'forged' }
      )
    ).status,
    403
  )
  assert.equal(
    (await api(0, '/api/control/branding', 'POST', { version: 0, config: sample })).status,
    409
  )
  assert.equal(
    (
      await api(0, '/api/control/branding', 'POST', {
        version: 1,
        config: { ...sample, logoUrl: 'javascript:alert(1)' }
      })
    ).status,
    400
  )
  assert.equal(
    (
      await api(0, '/api/control/branding', 'POST', {
        version: 1,
        config: { ...sample, clientSecret: 'forged' }
      })
    ).status,
    400
  )
  const second = await api(0, '/api/control/branding', 'POST', {
    version: 1,
    config: {
      ...sample,
      siteName: '示例：BFF数据平台',
      watermarkContentType: 'custom',
      watermarkCustomText: '内部验收'
    }
  })
  assert.equal(second.status, 200)
  assert.equal(second.data.version, 2)
  const session = await api(0, '/api/auth/session')
  assert.equal(session.status, 200)
  assert.ok(isObjectRecord(session.data.branding))
  assert.equal(session.data.branding.version, 2)
  assert.deepEqual(session.data.branding.config, second.data.config)
  console.log(
    'Branding HTTP checks passed: two configurations, tenant isolation, membership, Origin/CSRF, CAS, safe URLs and atomic session context.'
  )
} finally {
  execFileSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      'scripts/supabase-management.ps1',
      '-Action',
      'CleanupUpstreamFixtures'
    ],
    { cwd: process.cwd(), timeout: 120000, stdio: 'pipe' }
  )
  console.log('Synthetic branding fixtures removed.')
}
