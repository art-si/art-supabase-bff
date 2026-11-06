import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import {
  digest,
  opaqueToken,
  resolveAuthorizationUiRedirect,
  resolveAuthorizationLoginRedirect,
  safeEqual,
  safeReturnPath,
  seal,
  unseal
} from '../../server/security'
import { applicationInput } from '../../server/applications'
import { requireAdmin, requireMutation, type Member, type Session } from '../../server/auth'
import type { IncomingMessage } from 'node:http'

test('session encryption authenticates payloads and rejects tampering or a different key', () => {
  const key = randomBytes(32).toString('base64'),
    payload = { accessToken: 'private', refreshToken: 'secret', expiresAt: 1 }
  const encrypted = seal(payload, key)
  assert.deepEqual(unseal(encrypted, key), payload)
  assert.ok(!encrypted.includes('private'))
  const tampered = Buffer.from(encrypted, 'base64url')
  tampered[32] ^= 1
  assert.throws(() => unseal(tampered.toString('base64url'), key))
  assert.throws(() => unseal(encrypted, randomBytes(32).toString('base64')))
  assert.throws(() => seal(payload, 'bad-key'))
})
test('return paths cannot become external or backslash-based redirects', () => {
  for (const path of [
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    '/\nLocation:evil',
    '/\t/evil.example',
    '/..//evil.example',
    '/auth/login',
    '/AUTH/login',
    '/%61uth/login',
    '/applications/../auth/login',
    '/api/auth/login'
  ])
    assert.equal(safeReturnPath(path), '/applications')
  assert.equal(safeReturnPath('/applications?name=test'), '/applications?name=test')
  assert.equal(safeReturnPath('/'), '/applications')
  assert.equal(digest(opaqueToken()).length, 64)
  assert.equal(safeEqual('a', 'aa'), false)
  assert.equal(safeEqual('a', 'a'), true)
})

test('first-party entry opens only the configured login form and retains the opaque request', () => {
  const consent = 'https://identity.example/pro/#/auth/oauth-consent'
  const login = new URL(
    resolveAuthorizationLoginRedirect(
      `${consent}?authorization_id=test_request`,
      consent,
      true,
      'access_denied'
    )
  )
  assert.equal(login.origin, 'https://identity.example')
  assert.equal(login.pathname, '/pro/')
  assert.equal(login.hash.split('?')[0], '#/auth/login')
  const query = new URLSearchParams(login.hash.split('?')[1])
  assert.equal(query.get('sso_authorization_id'), 'test_request')
  assert.equal(query.get('sso_force'), '1')
  assert.equal(query.get('sso_error'), 'access_denied')
  assert.equal(query.get('redirect'), '/auth/login?sso_authorization_id=test_request')
  assert.throws(() =>
    resolveAuthorizationLoginRedirect(
      'https://evil.example/#/auth/oauth-consent?authorization_id=test',
      consent
    )
  )
})

test('the server-resolved authorization redirect is bound to the configured pro consent UI', () => {
  const base = 'https://identity.example/pro/#/auth/oauth-consent'
  assert.equal(
    resolveAuthorizationUiRedirect(`${base}?authorization_id=opaque-request_123`, base),
    `${base}?authorization_id=opaque-request_123`
  )
  for (const location of [
    'https://evil.example/pro/#/auth/oauth-consent?authorization_id=test',
    'https://identity.example/other/#/auth/oauth-consent?authorization_id=test',
    'https://identity.example/pro/#/auth/login?authorization_id=test',
    base,
    'https://user:secret@identity.example/pro/#/auth/oauth-consent?authorization_id=test'
  ])
    assert.throws(() => resolveAuthorizationUiRedirect(location, base))
})
test('application writes reject executable URLs, credential-bearing URLs and malformed state', () => {
  const valid = {
    code: 'sample-app',
    name: ' 示例应用 ',
    description: '',
    homeUrl: 'https://app.example',
    enabled: true
  }
  assert.equal(applicationInput(valid).name, '示例应用')
  for (const homeUrl of [
    'javascript:alert(1)',
    '//evil.example',
    'https://user:secret@app.example'
  ])
    assert.throws(() => applicationInput({ ...valid, homeUrl }))
  assert.throws(() => applicationInput({ ...valid, enabled: 'true' }))
  assert.throws(() => applicationInput({ ...valid, code: 'INVALID' }))
  assert.throws(() => applicationInput({ ...valid, name: '' }))
})
test('authentication alone does not grant administrator access', () => {
  assert.throws(() => requireAdmin({ role: 'viewer' } as Member))
  assert.doesNotThrow(() => requireAdmin({ role: 'admin' } as Member))
})
test('mutations require both an exact origin and the session CSRF token', () => {
  const session = { row: { csrf_token: 'known-token' } } as Session
  const request = (origin: string, token: string) =>
    ({ headers: { origin, 'x-csrf-token': token } }) satisfies Pick<IncomingMessage, 'headers'>
  assert.throws(() => requireMutation(request('https://evil.example', 'known-token'), session))
  assert.throws(() => requireMutation(request('http://localhost:3010', 'forged-token'), session))
  assert.doesNotThrow(() =>
    requireMutation(request('http://localhost:3010', 'known-token'), session)
  )
})
