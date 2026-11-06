import assert from 'node:assert/strict'
import test from 'node:test'
import { identityFetch } from '../../server/identity-http'

test('identity transport retries a failed GET once and never replays token POSTs', async (context) => {
  let calls = 0
  let alwaysFail = false
  context.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (alwaysFail || calls === 1) throw new TypeError('simulated connection reset')
    return new Response('ok')
  })
  assert.equal(await (await identityFetch('https://identity.invalid/metadata')).text(), 'ok')
  assert.equal(calls, 2)
  alwaysFail = true
  calls = 0
  await assert.rejects(
    identityFetch('https://identity.invalid/token', { method: 'POST' }),
    TypeError
  )
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(
    identityFetch('https://identity.invalid/metadata', { signal: AbortSignal.abort() }),
    TypeError
  )
  assert.equal(calls, 1)
})
