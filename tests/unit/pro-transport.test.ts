import assert from 'node:assert/strict'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import test from 'node:test'
import type { Session } from '../../server/auth'
import { config } from '../../server/config'
import { database } from '../../server/database/client'
import {
  authorizeProIntegrationOrigin,
  parseProDispatchPreflight,
  readProDispatchPreflight
} from '../../server/pro-transport'

const actor = '11111111-1111-4111-8111-111111111111'
const order = '22222222-2222-4222-8222-222222222222'
const vehicle = '33333333-3333-4333-8333-333333333333'
const session: Session = {
  member: {
    id: actor,
    issuer: config.issuer,
    subject: actor,
    tenant_id: actor,
    role: 'viewer',
    enabled: true,
    display_name: '',
    email: ''
  },
  row: {
    token_hash: '',
    member_id: actor,
    payload: '',
    csrf_token: '',
    expires_at: '2099-01-01T00:00:00Z'
  },
  tokens: {
    accessToken: 'identity-fixture-only',
    refreshToken: '',
    subject: actor,
    expiresAt: Date.now() + 60000
  }
}
const url = () =>
  new URL(
    `/api/integrations/pro/dispatch-preflight?orderId=${order}&vehicleId=${vehicle}&proSubject=${actor}&tenantScope=${actor}`,
    config.origin
  )
const clearCertificates = { blocked: false, canOverride: false, risks: [] }

test('preflight projects only approved business fields and rejects inconsistent results', () => {
  const parsed = parseProDispatchPreflight(
    [{ subjectLabel: '示例车辆', message: '待核对保养', secret: 'hidden' }],
    clearCertificates
  )
  assert.deepEqual(parsed.advisories, [{ subjectLabel: '示例车辆', message: '待核对保养' }])
  assert.throws(() => parseProDispatchPreflight([], { ...clearCertificates, blocked: true }))
  assert.throws(() =>
    parseProDispatchPreflight([], { ...clearCertificates, risks: [{ riskKind: 'unknown' }] })
  )
})
test('missing BFF application authorization stops all pro requests', async (t) => {
  t.mock.method(database, 'rpc', () =>
    Promise.resolve({ data: null, error: { message: 'BFF_FORBIDDEN' } })
  )
  const remote = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not call pro')
  })
  await assert.rejects(readProDispatchPreflight(session, url()), { status: 403 })
  assert.equal(remote.mock.callCount(), 0)
})
test('different pro and BFF accounts cannot run a combined check', async (t) => {
  const remote = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not call pro')
  })
  const target = url()
  target.searchParams.set('proSubject', vehicle)
  await assert.rejects(readProDispatchPreflight(session, target), { status: 409 })
  assert.equal(remote.mock.callCount(), 0)
})
test('existing pro permissions and tenant scope remain authoritative; tokens stay server-side', async (t) => {
  const before = config.proPublicKey
  config.proPublicKey = 'public-project-fixture'
  t.after(() => {
    config.proPublicKey = before
  })
  t.mock.method(database, 'rpc', () =>
    Promise.resolve({ data: { applicationId: order }, error: null })
  )
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: unknown, init?: RequestInit) => {
    const target = new URL(String(input))
    requests.push(target.pathname)
    assert.equal(target.origin, new URL(config.issuer).origin)
    assert.equal(init?.method, 'POST')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer identity-fixture-only')
    assert.equal(headers.get('x-art-tenant-scope'), vehicle)
    return Response.json(
      target.pathname.includes('tms_check')
        ? [{ subject_label: '测试车辆', message: '待核验' }]
        : { blocked: false, can_override: false, risks: [] }
    )
  })
  const target = url()
  target.searchParams.set('tenantScope', vehicle)
  const result = await readProDispatchPreflight(session, target)
  assert.equal(requests.length, 2)
  assert.ok(!JSON.stringify(result).includes('identity-fixture-only'))
  assert.equal(result.certificateBlocked, false)
})
test('untrusted website origins receive no credentialed CORS response', () => {
  const req = new IncomingMessage(new Socket())
  req.headers.origin = 'https://untrusted.example.test'
  const res = new ServerResponse(req)
  assert.throws(() => authorizeProIntegrationOrigin(req, res), { status: 403 })
  assert.equal(res.getHeader('Access-Control-Allow-Origin'), undefined)
})
