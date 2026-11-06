import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import {
  credentialKeyring,
  encryptCredential,
  decryptCredential
} from '../../server/upstream-credentials'

const originalKey = randomBytes(32).toString('base64')
const keyring = credentialKeyring(JSON.stringify({ v1: originalKey }))
const context = { tenantId: 'tenant-a', applicationId: 'app-a', serviceId: 'service-a', version: 1 }
test('upstream credentials authenticate tenant, application, service and credential version', () => {
  const encrypted = encryptCredential('test-secret-value', context, keyring)
  assert.equal(decryptCredential(encrypted, context, keyring), 'test-secret-value')
  assert.ok(!JSON.stringify(encrypted).includes('test-secret-value'))
  assert.notEqual(
    encryptCredential('test-secret-value', context, keyring).ciphertext,
    encrypted.ciphertext
  )
  for (const changed of [
    { ...context, tenantId: 'tenant-b' },
    { ...context, applicationId: 'app-b' },
    { ...context, serviceId: 'service-b' },
    { ...context, version: 2 }
  ])
    assert.throws(() => decryptCredential(encrypted, changed, keyring))
  const tampered = Buffer.from(encrypted.ciphertext, 'base64url')
  tampered[tampered.length - 1] ^= 1
  assert.throws(() =>
    decryptCredential(
      { ...encrypted, ciphertext: tampered.toString('base64url') },
      context,
      keyring
    )
  )
})
test('credential key rotation preserves old ciphertext only while its key is retained', () => {
  const encrypted = encryptCredential('old-secret', context, keyring)
  const nextKey = randomBytes(32).toString('base64')
  const both = credentialKeyring(JSON.stringify({ v1: originalKey, v2: nextKey }), 'v2')
  assert.equal(decryptCredential(encrypted, context, both), 'old-secret')
  assert.equal(encryptCredential('new-secret', { ...context, version: 2 }, both).keyId, 'v2')
  assert.throws(() =>
    decryptCredential(encrypted, context, credentialKeyring(JSON.stringify({ v2: nextKey }), 'v2'))
  )
  assert.throws(() => credentialKeyring('{"v1":"invalid"}'))
  assert.throws(() => credentialKeyring(JSON.stringify({ v2: nextKey }), 'v1'))
  assert.throws(() => encryptCredential('value', context, credentialKeyring()))
  assert.throws(() => encryptCredential('bad\r\nheader', context, keyring))
})
