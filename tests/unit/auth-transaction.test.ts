import assert from 'node:assert/strict'
import test from 'node:test'
import { saveLoginTransaction } from '../../server/auth'

test('an ambiguous transaction save replays the same state, browser binding, ciphertext and expiry once', async (context) => {
  const bodies: string[] = []
  const transaction = {
    state_hash: 'test-state',
    browser_hash: 'test-browser',
    payload: 'sealed-verifier',
    expires_at: '2030-01-01T00:00:00.000Z'
  }
  context.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = input instanceof Request ? input : new Request(input, init)
      assert.equal(request.method, 'POST')
      assert.equal(new URL(request.url).searchParams.get('on_conflict'), 'state_hash')
      assert.match(request.headers.get('prefer') || '', /resolution=merge-duplicates/)
      bodies.push(await request.text())
      if (bodies.length === 1)
        throw new TypeError('connection closed after server received the save')
      return Response.json({ state_hash: transaction.state_hash }, { status: 201 })
    }
  )
  await saveLoginTransaction(transaction)
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
  assert.deepEqual(JSON.parse(bodies[1]), transaction)
})

test('persistent transport failure stops after two saves; authorization errors are not replayed', async (context) => {
  let count = 0,
    unauthorized = false
  context.mock.method(globalThis, 'fetch', async () => {
    count++
    if (!unauthorized) throw new TypeError('simulated outage')
    return Response.json({ code: '42501', message: 'denied' }, { status: 403 })
  })
  const transaction = {
    state_hash: 'test',
    browser_hash: 'test',
    payload: 'sealed',
    expires_at: '2030-01-01T00:00:00Z'
  }
  await assert.rejects(saveLoginTransaction(transaction))
  assert.equal(count, 2)
  unauthorized = true
  count = 0
  await assert.rejects(saveLoginTransaction(transaction))
  assert.equal(count, 1)
})
