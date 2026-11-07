import assert from 'node:assert/strict'
import test from 'node:test'
import { remoteFetch } from '../../server/remote-http'

test('trusted remote transport retries a failed GET once and never replays token or database POSTs', async (context) => {
  let calls = 0
  let alwaysFail = false
  context.mock.method(globalThis, 'fetch', async () => {
    calls++
    if (alwaysFail || calls === 1) throw new TypeError('simulated connection reset')
    return new Response('ok')
  })
  assert.equal(await (await remoteFetch('https://identity.invalid/metadata')).text(), 'ok')
  assert.equal(calls, 2)
  alwaysFail = true
  calls = 0
  await assert.rejects(remoteFetch('https://identity.invalid/token', { method: 'POST' }), TypeError)
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(
    remoteFetch('https://identity.invalid/metadata', { signal: AbortSignal.abort() }),
    TypeError
  )
  assert.equal(calls, 1)
  calls = 0
  await assert.rejects(
    remoteFetch('https://database.invalid/rest/v1/rpc/write', { method: 'POST', body: '{}' }),
    TypeError
  )
  assert.equal(calls, 1)
})

test('remote transport preserves caller cancellation and does not retry HTTP errors', async (context) => {
  const caller = new AbortController()
  let calls = 0
  context.mock.method(
    globalThis,
    'fetch',
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls++
      assert.ok(init?.signal)
      caller.abort()
      assert.equal(init.signal.aborted, true)
      return new Response('unavailable', { status: 503 })
    }
  )
  const response = await remoteFetch('https://database.invalid/rest/v1/sessions', {
    signal: caller.signal
  })
  assert.equal(response.status, 503)
  assert.equal(calls, 1)
})
