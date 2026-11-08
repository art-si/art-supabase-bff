import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import serverless from 'serverless-http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { handler } from '../../netlify/functions/bff'
import { body, setCookie, json } from '../../server/http'

function event(path: string, method = 'GET') {
  return {
    path,
    httpMethod: method,
    headers: { host: 'forged.example', 'content-type': 'application/json' },
    queryStringParameters: {},
    body: '',
    isBase64Encoded: false
  }
}

test('Netlify routes preserve health and deny protected APIs without a session', async () => {
  for (const path of ['/api/health', '/.netlify/functions/bff/api/health']) {
    const response = await handler(event(path), {})
    assert.ok(isObjectRecord(response))
    assert.equal(response.statusCode, 200)
    assert.equal(typeof response.body, 'string')
    assert.equal(response.isBase64Encoded, true)
    assert.equal(
      JSON.parse(Buffer.from(String(response.body), 'base64').toString('utf8')).status,
      'ok'
    )
    assert.ok(isObjectRecord(response.headers))
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  const protectedResponse = await handler(event('/api/applications'), {})
  assert.ok(isObjectRecord(protectedResponse))
  assert.equal(protectedResponse.statusCode, 401)
})

test('login entry keeps restart behavior and rejects external return targets', async () => {
  const response = await handler(
    {
      ...event('/auth/login'),
      queryStringParameters: { error: 'access_denied', returnTo: 'https://forged.example/' }
    },
    {}
  )
  assert.ok(isObjectRecord(response))
  assert.equal(response.statusCode, 303)
  assert.ok(isObjectRecord(response.headers))
  const location = String(response.headers.location)
  assert.ok(location.startsWith('/api/auth/login?'))
  assert.ok(location.includes('force_login=1'))
  assert.ok(!location.includes('forged.example'))
})

test('Lambda transport preserves request bytes and separate HttpOnly cookies', async () => {
  const transport = serverless(
    createServer((req, res) => {
      void (async () => {
        const parsed = await body(req)
        setCookie(res, 'session', 'opaque-session', 60)
        setCookie(res, 'transaction', 'opaque-transaction', 60)
        json(res, parsed)
      })()
    })
  )
  const payload = { name: '品牌配置', enabled: true }
  const response = await transport(
    {
      ...event('/api/example', 'POST'),
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      isBase64Encoded: true
    },
    {}
  )
  assert.ok(isObjectRecord(response))
  assert.equal(response.statusCode, 200)
  assert.equal(typeof response.body, 'string')
  assert.deepEqual(JSON.parse(String(response.body)), payload)
  assert.ok(isObjectRecord(response.multiValueHeaders))
  const cookies = response.multiValueHeaders['set-cookie']
  assert.ok(Array.isArray(cookies))
  assert.equal(cookies.length, 2)
  assert.ok(cookies.every((cookie) => typeof cookie === 'string' && cookie.includes('HttpOnly')))
})
