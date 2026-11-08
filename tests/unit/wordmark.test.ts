import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import test from 'node:test'
import type { Session } from '../../server/auth'
import { config } from '../../server/config'
import { database } from '../../server/database/client'
import { generateBrandWordmark } from '../../server/wordmark'

const session: Session = {
  member: {
    id: '11111111-1111-4111-8111-111111111111',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    issuer: config.issuer,
    subject: 'fixture',
    display_name: '示例管理员',
    email: 'admin@example.test',
    role: 'admin',
    enabled: true
  },
  row: {
    token_hash: 'fixture',
    member_id: '11111111-1111-4111-8111-111111111111',
    payload: '',
    csrf_token: 'fixture-csrf',
    expires_at: '2099-01-01T00:00:00Z'
  },
  tokens: {
    accessToken: 'server-only-fixture-token',
    refreshToken: 'server-only-refresh',
    subject: 'fixture',
    expiresAt: Date.now() + 60000
  }
}
function request(csrf = 'fixture-csrf'): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.headers = { origin: config.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }
  req.push(JSON.stringify({ siteName: '示例平台' }))
  req.push(null)
  return req
}
test('generation requires its own BFF permission before calling identity AI', async (t) => {
  const checked: string[] = []
  t.mock.method(database, 'rpc', (_name: string, params: { p_permission: string }) => {
    checked.push(params.p_permission)
    return Promise.resolve({
      data: params.p_permission !== 'System:WebsiteConfig:GenerateWordmark',
      error: null
    })
  })
  const provider = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('must not invoke AI')
  })
  await assert.rejects(generateBrandWordmark(request(), session), { status: 403 })
  assert.ok(checked.includes('System:WebsiteConfig:GenerateWordmark'))
  assert.equal(provider.mock.callCount(), 0)
})
test('generation retains CSRF validation and returns only the public image DTO', async (t) => {
  t.mock.method(database, 'rpc', () => Promise.resolve({ data: true, error: null }))
  const provider = t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer server-only-fixture-token'
    )
    return Response.json({
      imageBase64: 'fixture-image',
      mimeType: 'image/png',
      runId: 'fixture-run',
      apiKey: 'must-not-escape',
      accessToken: 'must-not-escape'
    })
  })
  await assert.rejects(generateBrandWordmark(request('invalid'), session), { status: 403 })
  assert.equal(provider.mock.callCount(), 0)
  const result = await generateBrandWordmark(request(), session)
  assert.ok(result && typeof result === 'object')
  assert.ok(!JSON.stringify(result).includes('must-not-escape'))
  assert.equal(provider.mock.callCount(), 1)
})
