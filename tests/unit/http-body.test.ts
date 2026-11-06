import assert from 'node:assert/strict'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { body, HttpError } from '../../server/http'

function request(contentType = 'application/json'): IncomingMessage {
  const message = new IncomingMessage(new Socket())
  message.headers['content-type'] = contentType
  return message
}

test('streamed JSON preserves Chinese characters split across network chunks', async () => {
  const message = request('application/json; charset=UTF-8')
  const payload = Buffer.from(JSON.stringify({ name: '统一认证工作台' }))
  const split = payload.indexOf(Buffer.from('统')) + 1
  const result = body(message)
  message.push(payload.subarray(0, split))
  await setImmediate()
  message.push(payload.subarray(split))
  message.push(null)
  assert.deepEqual(await result, { name: '统一认证工作台' })
  message.destroy()
})

test('batch endpoints can declare a bounded larger JSON budget without changing normal endpoints', async () => {
  const payload = JSON.stringify({ configuration: 'x'.repeat(20000) })
  for (const [maxBytes, accepted] of [
    [16384, false],
    [32768, true]
  ] as const) {
    const message = request()
    message.push(Buffer.from(payload))
    message.push(null)
    if (accepted) assert.equal((await body(message, maxBytes)).configuration, 'x'.repeat(20000))
    else
      await assert.rejects(
        body(message),
        (error: unknown) => error instanceof HttpError && error.status === 413
      )
    message.destroy()
  }
})

test('JSON lookalike media types and unsupported character encodings are rejected', async () => {
  for (const contentType of [
    'application/jsonp',
    'text/plain',
    'application/json; charset=utf-16'
  ]) {
    const message = request(contentType)
    message.push(Buffer.from('{}'))
    message.push(null)
    await assert.rejects(
      body(message),
      (error: unknown) => error instanceof HttpError && error.status === 415
    )
    message.destroy()
  }
})

test('business request bodies must contain JSON objects', async () => {
  for (const value of ['null', '[]', '42', '{']) {
    const message = request()
    message.push(Buffer.from(value))
    message.push(null)
    await assert.rejects(
      body(message),
      (error: unknown) => error instanceof HttpError && error.status === 400
    )
    message.destroy()
  }
})
