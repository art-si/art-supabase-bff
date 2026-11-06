import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveBffOrigin } from '../../server/config'

test('callbacks follow the configured local or deployed BFF origin', () => {
  for (const origin of ['http://localhost:3010', 'https://bff.example.com']) {
    const resolved = resolveBffOrigin(origin, origin.startsWith('https:'), 3010)
    assert.equal(new URL('/api/auth/callback', resolved).href, `${origin}/api/auth/callback`)
  }
  assert.equal(resolveBffOrigin(undefined, false, 3020), 'http://localhost:3020')
})

test('production cannot silently fall back to localhost or accept an unsafe public origin', () => {
  assert.throws(() => resolveBffOrigin(undefined, true, 3010))
  for (const origin of [
    'http://localhost:3010',
    'http://bff.example.com',
    'https://user:secret@bff.example.com',
    'https://bff.example.com/subpath',
    'https://bff.example.com?returnTo=bad'
  ])
    assert.throws(() => resolveBffOrigin(origin, true, 3010))
})
