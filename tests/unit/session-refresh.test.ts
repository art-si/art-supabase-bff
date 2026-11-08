import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { ResponseBodyError } from 'openid-client'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { authenticate } from '../../server/auth'
import { config } from '../../server/config'
import { digest, seal, unseal } from '../../server/security'

const row = { token_hash: 'a'.repeat(64), payload: 'sealed-before' }

test('authenticate persists only encrypted refreshed tokens and returns the current session snapshot', async (t) => {
  const original = { ...config }
  t.after(() => Object.assign(config, original))
  Object.assign(config, {
    clientId: 'fixture-client',
    sessionKey: Buffer.alloc(32, 7).toString('base64'),
    databaseUrl: 'https://database.example.test',
    databaseKey: 'server-fixture-key'
  })
  const tokens = {
    accessToken: 'expired-fixture',
    refreshToken: 'old-fixture-refresh',
    subject: 'fixture',
    expiresAt: 1
  }
  const member = {
    id: randomUUID(),
    tenant_id: randomUUID(),
    issuer: config.issuer,
    subject: tokens.subject,
    display_name: '示例成员',
    email: 'member@example.test',
    role: 'viewer',
    enabled: true
  }
  const opaqueCookie = 'opaque-fixture-cookie'
  const stored = {
    token_hash: digest(opaqueCookie),
    payload: seal(tokens, config.sessionKey),
    member_id: member.id,
    csrf_token: 'fixture-csrf',
    expires_at: '2099-01-01T00:00:00Z',
    member
  }
  let saved = ''
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const req = input instanceof Request ? input : new Request(input, init)
      const url = new URL(req.url)
      if (url.pathname.includes('.well-known'))
        return Response.json({
          issuer: config.issuer,
          authorization_endpoint: `${config.issuer}/authorize`,
          token_endpoint: `${config.issuer}/token`,
          userinfo_endpoint: `${config.issuer}/userinfo`,
          response_types_supported: ['code'],
          token_endpoint_auth_methods_supported: ['client_secret_post']
        })
      if (url.pathname.endsWith('/token'))
        return Response.json({
          access_token: 'fresh-fixture-access',
          refresh_token: 'fresh-fixture-refresh',
          token_type: 'Bearer',
          expires_in: 3600
        })
      if (url.pathname.endsWith('/userinfo')) {
        assert.equal(req.headers.get('authorization'), 'Bearer fresh-fixture-access')
        return Response.json({ sub: tokens.subject })
      }
      if (url.pathname.endsWith('/bff_sessions')) {
        assert.equal(url.searchParams.get('token_hash'), `eq.${stored.token_hash}`)
        return Response.json([stored])
      }
      const params: unknown = await req.json()
      assert.ok(isObjectRecord(params))
      assert.equal(params.p_payload, stored.payload)
      if (url.pathname.endsWith('/bff_session_refresh_claim'))
        return Response.json({ status: 'claimed' })
      assert.ok(url.pathname.endsWith('/bff_session_refresh_finish'))
      assert.equal(typeof params.p_next_payload, 'string')
      saved = String(params.p_next_payload)
      assert.ok(!saved.includes('fresh-fixture-access'))
      return Response.json({ status: 'updated', payload: saved })
    }
  )
  const req = new IncomingMessage(new Socket())
  req.headers = { cookie: `bff_session=${opaqueCookie}`, 'x-art-tenant-scope': randomUUID() }
  const session = await authenticate(req)
  assert.equal(session.tokens.accessToken, 'fresh-fixture-access')
  assert.equal(session.member.tenant_id, member.tenant_id)
  assert.equal(session.member.role, 'viewer')
  assert.equal(session.row.payload, saved)
  assert.deepEqual(unseal(saved, config.sessionKey), session.tokens)
})
async function worker(): Promise<typeof import('../../server/session-refresh')> {
  // Distinct module instances model separate serverless processes sharing only the database.
  return import(
    new URL(`../../server/session-refresh.ts?worker=${randomUUID()}`, import.meta.url).href
  )
}
async function request(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  const value = input instanceof Request ? input : new Request(input, init)
  const params: unknown = await value.json()
  assert.ok(isObjectRecord(params))
  assert.equal(value.method, 'POST')
  assert.equal(params.p_token_hash, row.token_hash)
  assert.equal(params.p_payload, row.payload)
  assert.equal(typeof params.p_lease, 'string')
  return { operation: new URL(value.url).pathname.split('/').at(-1), params }
}

test('separate workers refresh once and the waiter receives the committed ciphertext', async (t) => {
  let lease: unknown,
    committed = false,
    exchanges = 0,
    busy = 0
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { operation, params } = await request(input, init)
      if (operation === 'bff_session_refresh_claim') {
        if (committed) return Response.json({ status: 'updated', payload: 'sealed-after' })
        lease ??= params.p_lease
        if (lease === params.p_lease) return Response.json({ status: 'claimed' })
        busy++
        return Response.json({ status: 'busy' })
      }
      assert.equal(operation, 'bff_session_refresh_finish')
      assert.equal(params.p_lease, lease)
      assert.equal(params.p_next_payload, 'sealed-after')
      committed = true
      return Response.json({ status: 'updated', payload: 'sealed-after' })
    }
  )
  const [a, b] = await Promise.all([worker(), worker()])
  const exchange = async () => {
    exchanges++
    await delay(40)
    return 'sealed-after'
  }
  assert.deepEqual(
    await Promise.all([
      a.refreshSessionPayload(row, exchange),
      b.refreshSessionPayload(row, exchange)
    ]),
    ['sealed-after', 'sealed-after']
  )
  assert.equal(exchanges, 1)
  assert.ok(busy > 0)
})

test('requests in one worker share one refresh operation', async (t) => {
  let calls = 0,
    exchanges = 0
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { operation } = await request(input, init)
      calls++
      return Response.json(
        operation === 'bff_session_refresh_claim'
          ? { status: 'claimed' }
          : { status: 'updated', payload: 'sealed-after' }
      )
    }
  )
  const current = await worker()
  const exchange = async () => {
    exchanges++
    await delay(20)
    return 'sealed-after'
  }
  await Promise.all([
    current.refreshSessionPayload(row, exchange),
    current.refreshSessionPayload(row, exchange)
  ])
  assert.equal(calls, 2)
  assert.equal(exchanges, 1)
})

test('a logout or membership revocation during refresh cannot recreate the session', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { operation } = await request(input, init)
      return Response.json({
        status: operation === 'bff_session_refresh_claim' ? 'claimed' : 'missing'
      })
    }
  )
  const current = await worker()
  await assert.rejects(
    current.refreshSessionPayload(row, async () => 'sealed-late'),
    {
      status: 401,
      code: 'UNAUTHENTICATED'
    }
  )
})

test('a stale invalid grant reads the newer ciphertext instead of deleting its session', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { operation, params } = await request(input, init)
      if (operation === 'bff_session_refresh_claim') return Response.json({ status: 'claimed' })
      assert.equal(params.p_next_payload, null)
      return Response.json({ status: 'updated', payload: 'sealed-by-new-holder' })
    }
  )
  const current = await worker()
  const invalid = new ResponseBodyError('invalid grant fixture', {
    cause: { error: 'invalid_grant' },
    response: Response.json({ error: 'invalid_grant' }, { status: 400 })
  })
  assert.equal(
    await current.refreshSessionPayload(row, async () => {
      throw invalid
    }),
    'sealed-by-new-holder'
  )
})

test('ambiguous provider failures keep the lease and database failures never fall back to local-only refresh', async (t) => {
  let finishCalls = 0,
    unavailable = false
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { operation } = await request(input, init)
      if (unavailable)
        return Response.json({ code: 'PGRST202', message: 'fixture failure' }, { status: 404 })
      if (operation === 'bff_session_refresh_finish') finishCalls++
      return Response.json({ status: 'claimed' })
    }
  )
  const current = await worker()
  await assert.rejects(
    current.refreshSessionPayload(row, async () => {
      throw new TypeError('fixture disconnect')
    }),
    {
      status: 503,
      code: 'AUTH_SESSION_UNAVAILABLE'
    }
  )
  assert.equal(finishCalls, 0)
  unavailable = true
  let exchanged = false
  await assert.rejects(
    current.refreshSessionPayload(row, async () => {
      exchanged = true
      return 'unexpected'
    }),
    {
      status: 503,
      code: 'SESSION_REFRESH_UNAVAILABLE'
    }
  )
  assert.equal(exchanged, false)
})

test('a continuously busy lease returns a retryable error without refreshing or waiting for lease expiry', async (t) => {
  let calls = 0,
    exchanged = false
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ status: 'busy' })
  })
  const current = await worker()
  await assert.rejects(
    current.refreshSessionPayload(row, async () => {
      exchanged = true
      return 'unexpected'
    }),
    { status: 503, code: 'SESSION_REFRESH_BUSY' }
  )
  assert.equal(exchanged, false)
  assert.ok(calls >= 2 && calls <= 12)
})

test('a lost lease never returns uncommitted tokens and malformed database states fail closed', async (t) => {
  let malformed = false
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const { operation } = await request(input, init)
      if (malformed) return Response.json({ status: 'updated', payload: '' })
      return Response.json({
        status: operation === 'bff_session_refresh_claim' ? 'claimed' : 'busy'
      })
    }
  )
  const current = await worker()
  await assert.rejects(
    current.refreshSessionPayload(row, async () => 'uncommitted'),
    {
      status: 503,
      code: 'SESSION_REFRESH_BUSY'
    }
  )
  malformed = true
  let exchanged = false
  await assert.rejects(
    current.refreshSessionPayload(row, async () => {
      exchanged = true
      return 'unexpected'
    }),
    { status: 503, code: 'SESSION_REFRESH_UNAVAILABLE' }
  )
  assert.equal(exchanged, false)
})
