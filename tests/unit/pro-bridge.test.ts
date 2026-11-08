import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { SignJWT } from 'jose'
import {
  PRO_BRIDGE_AUDIENCE,
  PRO_BRIDGE_ISSUER,
  PRO_BRIDGE_TYPE,
  verifyProBridgeAssertion
} from '../../server/pro-bridge'
import { parseProBridgeInvocation } from '../../server/gateway'
import { HttpError } from '../../server/http'
import { digest } from '../../server/security'

const key = randomBytes(32)
const secret = key.toString('base64')
const now = Math.floor(Date.UTC(2026, 10, 8, 8) / 1000)
const subject = randomUUID()
const nonce = randomUUID()
const payload = {
  operation: 'invoke',
  applicationCode: 'sample-app',
  environment: 'development',
  path: '/orders/A',
  method: 'GET',
  query: { current: 1, size: 2 },
  body: {}
}

async function assertion(
  input: unknown = payload,
  options: {
    issuer?: string
    audience?: string
    typ?: string
    sub?: string
    jti?: string
    issuedAt?: number
    expiresAt?: number
    bodyHash?: string
  } = {}
): Promise<string> {
  return new SignJWT({ bodyHash: options.bodyHash ?? digest(JSON.stringify(input)) })
    .setProtectedHeader({ alg: 'HS256', typ: options.typ ?? PRO_BRIDGE_TYPE })
    .setIssuer(options.issuer ?? PRO_BRIDGE_ISSUER)
    .setAudience(options.audience ?? PRO_BRIDGE_AUDIENCE)
    .setSubject(options.sub ?? subject)
    .setJti(options.jti ?? nonce)
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 60)
    .sign(key)
}

const unauthorized = (error: unknown): boolean =>
  error instanceof HttpError && error.status === 401 && error.code === 'BRIDGE_UNAUTHORIZED'

test('signed bridge intent binds verified subject, exact body and one-time nonce identity', async () => {
  const signed = await assertion()
  const verified = await verifyProBridgeAssertion(signed, payload, secret, new Date(now * 1000))
  assert.equal(verified.subject, subject)
  assert.equal(verified.nonceHash, digest(`${PRO_BRIDGE_ISSUER}\0${subject}\0${nonce}`))
  assert.equal(verified.expiresAt, new Date((now + 60) * 1000).toISOString())
  assert.ok(!JSON.stringify(verified).includes(secret))
  await assert.rejects(
    verifyProBridgeAssertion(
      signed,
      { ...payload, path: '/orders/B' },
      secret,
      new Date(now * 1000)
    ),
    unauthorized
  )
})

test('bridge rejects forged issuer, audience, type, expiry, TTL and subject', async () => {
  const variants = [
    { issuer: 'https://other.example/auth/v1' },
    { audience: 'other-application' },
    { typ: 'JWT' },
    { expiresAt: now - 1 },
    { expiresAt: now + 61 },
    { issuedAt: now + 4, expiresAt: now + 60 },
    { sub: 'not-a-uuid' },
    { jti: 'not-a-uuid' },
    { bodyHash: '0'.repeat(64) }
  ]
  for (const variant of variants)
    await assert.rejects(
      verifyProBridgeAssertion(
        await assertion(payload, variant),
        payload,
        secret,
        new Date(now * 1000)
      ),
      unauthorized
    )
  await assert.rejects(
    verifyProBridgeAssertion(await assertion(), payload, 'not-a-base64-key', new Date(now * 1000)),
    (error: unknown) => error instanceof HttpError && error.code === 'BRIDGE_NOT_CONFIGURED'
  )
})

test('bridge payload accepts only declared routes and never trusts role or tenant fields', () => {
  assert.deepEqual(parseProBridgeInvocation({ operation: 'catalog' }), { operation: 'catalog' })
  assert.equal(parseProBridgeInvocation(payload).operation, 'invoke')
  for (const invalid of [
    { operation: 'catalog', tenantId: randomUUID() },
    { ...payload, role: 'admin' },
    { ...payload, tenantId: randomUUID() },
    { ...payload, path: 'https://outside.example/items' },
    { ...payload, path: '/../admin' },
    { ...payload, query: { current: { nested: true } } },
    { ...payload, method: 'POST', idempotencyKey: 'not-a-uuid' }
  ])
    assert.throws(() => parseProBridgeInvocation(invalid))
})
