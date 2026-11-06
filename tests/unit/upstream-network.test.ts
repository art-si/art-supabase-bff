import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
  executeUpstreamRequest,
  isSafeCredentialHeader,
  normalizeUpstreamUrl,
  probeUpstream,
  validateUpstreamPolicy,
  type UpstreamExecutionRequest,
  type UpstreamNetworkPolicy
} from '../../server/upstream-network'

const productionPolicy: UpstreamNetworkPolicy = {
  allowedOrigins: ['https://service.example'],
  allowedCidrs: [],
  allowLocalHttp: false,
  production: true
}

async function withLocalServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function localPolicy(origin: string): UpstreamNetworkPolicy {
  return {
    allowedOrigins: [origin],
    allowedCidrs: [],
    allowLocalHttp: true,
    production: false
  }
}

test('URL normalization enforces HTTPS and strips only trailing path separators', () => {
  assert.equal(
    normalizeUpstreamUrl('https://service.example/api///'),
    'https://service.example/api'
  )
  assert.equal(normalizeUpstreamUrl('https://service.example/'), 'https://service.example/')
  for (const target of [
    'http://service.example',
    'https://user:pass@service.example',
    'https://service.example/api?token=secret',
    'https://service.example/api#fragment',
    'https://service.example/%0aadmin',
    'https://service.example/a\\b',
    'file:///etc/passwd'
  ]) {
    assert.throws(() => normalizeUpstreamUrl(target))
  }
})

test('policy accepts exact origins and CIDRs, rejecting malformed deploy configuration', () => {
  validateUpstreamPolicy(productionPolicy)
  validateUpstreamPolicy({ ...productionPolicy, allowedCidrs: ['10.0.0.0/8', 'fd00::/8'] })
  for (const policy of [
    { ...productionPolicy, allowedOrigins: ['https://service.example/path'] },
    { ...productionPolicy, allowedOrigins: ['https://user@service.example'] },
    { ...productionPolicy, allowedOrigins: ['https://service.example/'] },
    { ...productionPolicy, allowedOrigins: ['https://localhost'] },
    { ...productionPolicy, allowedOrigins: ['https://127.0.0.1'] },
    {
      ...productionPolicy,
      allowedOrigins: ['https://169.254.169.254'],
      allowedCidrs: ['169.254.0.0/16']
    },
    { ...productionPolicy, allowedOrigins: ['https://[fe80::1]'], allowedCidrs: ['fe80::/10'] },
    { ...productionPolicy, allowedCidrs: ['10.0.0.0/33'] },
    { ...productionPolicy, allowedCidrs: ['fe80::/129'] },
    { ...productionPolicy, allowedCidrs: ['not-an-ip/24'] },
    { ...productionPolicy, allowLocalHttp: true }
  ]) {
    assert.throws(
      () => validateUpstreamPolicy(policy),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'invalid_policy' &&
        !error.message.includes('service.example')
    )
  }
})

test('credential header policy reserves transport headers and managed bearer authority', () => {
  assert.equal(isSafeCredentialHeader('X-Api-Key'), true)
  assert.equal(isSafeCredentialHeader('Authorization'), false)
  assert.equal(isSafeCredentialHeader('Authorization', true), true)
  for (const header of [
    'Accept',
    'Content-Type',
    'Proxy-Connection',
    'Cookie',
    'Host',
    'X-Forwarded-For',
    'Invalid Header'
  ]) {
    assert.equal(isSafeCredentialHeader(header, true), false, header)
  }
})

test('loopback fixture verifies network reachability, redirects, body cap, timeout and fixed headers', async () => {
  let requests = 0
  const headers: Array<IncomingMessage['headers']> = []
  await withLocalServer(
    (request, response) => {
      requests += 1
      headers.push(request.headers)
      switch (request.url) {
        case '/auth':
          response.writeHead(401).end('authentication required')
          break
        case '/redirect':
          response.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }).end()
          break
        case '/large':
          response.writeHead(200).end(Buffer.alloc(64 * 1024 + 1))
          break
        case '/invalid-status':
          response.writeHead(700).end('invalid status')
          break
        case '/slow':
          setTimeout(() => response.end('late'), 300)
          break
        default:
          response.writeHead(200).end('ready')
      }
    },
    async (origin) => {
      const policy = localPolicy(origin)
      assert.deepEqual(
        (({ status, code, statusCode }) => ({ status, code, statusCode }))(
          await probeUpstream(`${origin}/auth`, 1000, policy)
        ),
        { status: 'reachable', code: 'reachable', statusCode: 401 }
      )
      assert.equal(
        (await probeUpstream(`${origin}/redirect`, 1000, policy)).code,
        'redirect_blocked'
      )
      assert.equal(
        (await probeUpstream(`${origin}/large`, 1000, policy)).code,
        'response_too_large'
      )
      assert.deepEqual(
        (({ status, code, statusCode }) => ({ status, code, statusCode }))(
          await probeUpstream(`${origin}/invalid-status`, 1000, policy)
        ),
        { status: 'failed', code: 'connection_failed', statusCode: null }
      )
      assert.equal((await probeUpstream(`${origin}/slow`, 100, policy)).code, 'timeout')
      assert.equal(requests, 5)
      for (const seen of headers) {
        assert.equal(seen.accept, '*/*')
        assert.equal(seen.authorization, undefined)
        assert.equal(seen.cookie, undefined)
        assert.equal(seen['proxy-authorization'], undefined)
      }
    }
  )
})

test('exact origin gate rejects before DNS and all resolved addresses must be safe', async () => {
  let resolutionCalls = 0
  const resolver = async () => {
    resolutionCalls += 1
    return [
      { address: '127.0.0.1', family: 4 },
      { address: '169.254.169.254', family: 4 }
    ]
  }
  const denied = await probeUpstream(
    'https://service.example',
    1000,
    {
      ...productionPolicy,
      allowedOrigins: []
    },
    resolver
  )
  assert.equal(denied.code, 'target_not_allowed')
  assert.equal(resolutionCalls, 0)

  await withLocalServer(
    (_, response) => response.end('should not run'),
    async (origin) => {
      const mixed = await probeUpstream(
        origin.replace('127.0.0.1', 'localhost'),
        1000,
        localPolicy(origin.replace('127.0.0.1', 'localhost')),
        resolver
      )
      assert.equal(mixed.code, 'target_blocked')
      assert.equal(resolutionCalls, 1)
    }
  )
})

test('mapped IPv6 and metadata/link-local addresses cannot bypass the address policy', async () => {
  for (const [address, allowedCidrs] of [
    ['::ffff:127.0.0.1', ['127.0.0.0/8']],
    ['::ffff:10.0.0.8', []],
    ['::ffff:169.254.169.254', ['169.254.0.0/16']],
    ['fd00:ec2::254', ['fd00::/8']],
    ['fe80::1', ['fe80::/10']],
    ['2001:db8::1', []]
  ] as const) {
    const response = await probeUpstream(
      'https://service.example',
      1000,
      { ...productionPolicy, allowedCidrs },
      async () => [{ address, family: 6 }]
    )
    assert.equal(response.code, 'target_blocked', address)
  }
})

test('connection pins the first validated DNS result and never resolves the host again', async () => {
  await withLocalServer(
    (_, response) => response.writeHead(200).end('ready'),
    async (origin) => {
      const hostnameOrigin = origin.replace('127.0.0.1', 'localhost')
      let calls = 0
      const response = await probeUpstream(
        hostnameOrigin,
        1000,
        localPolicy(hostnameOrigin),
        async () => {
          calls += 1
          return [{ address: calls === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }]
        }
      )
      assert.equal(response.status, 'reachable')
      assert.equal(calls, 1)
    }
  )
})

test('DNS resolution consumes the total deadline and cannot start a late request', async () => {
  let requested = false
  await withLocalServer(
    (_, response) => {
      requested = true
      response.end('late')
    },
    async (origin) => {
      const hostnameOrigin = origin.replace('127.0.0.1', 'localhost')
      const response = await probeUpstream(
        hostnameOrigin,
        100,
        localPolicy(hostnameOrigin),
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 160))
          return [{ address: '127.0.0.1', family: 4 }]
        }
      )
      assert.equal(response.code, 'timeout')
      await new Promise((resolve) => setTimeout(resolve, 180))
      assert.equal(requested, false)
    }
  )
})

test('orchestration request keeps the base path, encodes query and sends only controlled headers', async () => {
  const seen: Array<{
    url: string
    method: string
    headers: IncomingMessage['headers']
    body: string
  }> = []
  await withLocalServer(
    (request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        seen.push({
          url: request.url || '',
          method: request.method || '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ data: { value: 12, items: [{ id: 'sample' }] } }))
      })()
    },
    async (origin) => {
      const policy = localPolicy(origin)
      const get = await executeUpstreamRequest(
        `${origin}/v1`,
        { method: 'GET', path: '/orders/ABC-1', query: { q: 'A B', mode: 'full' } },
        1000,
        policy
      )
      assert.deepEqual(get.body, { data: { value: 12, items: [{ id: 'sample' }] } })
      assert.equal(get.ok, true)
      assert.equal(get.code, 'reachable')
      assert.equal(get.statusCode, 200)
      assert.equal(seen[0].url, '/v1/orders/ABC-1?q=A+B&mode=full')
      assert.equal(seen[0].method, 'GET')
      assert.equal(seen[0].headers.accept, 'application/json')
      assert.equal(seen[0].headers['accept-encoding'], 'identity')
      assert.equal(seen[0].headers.authorization, undefined)
      assert.equal(seen[0].headers.cookie, undefined)
      assert.equal(seen[0].body, '')

      const post = await executeUpstreamRequest(
        `${origin}/v1`,
        {
          method: 'POST',
          path: '/quote',
          query: {},
          body: { weight: 12.5, from: '上海' },
          credential: { headerName: 'Authorization', value: 'Bearer server-only-secret' }
        },
        1000,
        policy
      )
      assert.equal(post.ok, true)
      assert.equal(seen[1].url, '/v1/quote')
      assert.equal(seen[1].method, 'POST')
      assert.equal(seen[1].headers.authorization, 'Bearer server-only-secret')
      assert.match(seen[1].headers['content-type'] || '', /^application\/json/)
      assert.deepEqual(JSON.parse(seen[1].body), { weight: 12.5, from: '上海' })
      assert.ok(!JSON.stringify(post).includes('server-only-secret'))

      for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
        const result = await executeUpstreamRequest(
          `${origin}/v1`,
          {
            method,
            path: '/record',
            query: {},
            body: { action: method },
            credential: { headerName: 'X-Api-Key', value: 'server-api-key' }
          },
          1000,
          policy
        )
        assert.equal(result.ok, true, `${method}:${result.code}:${result.statusCode}`)
        const recorded = seen.at(-1)
        assert.equal(recorded?.method, method)
        assert.equal(recorded?.headers['x-api-key'], 'server-api-key')
        assert.ok(!JSON.stringify(result).includes('server-api-key'))
      }
      for (const credential of [
        { headerName: 'X-Api-Key', value: 'x'.repeat(8192) },
        { headerName: 'Authorization', value: `Bearer ${'x'.repeat(8192)}` }
      ]) {
        const result = await executeUpstreamRequest(
          origin,
          { method: 'GET', path: '/boundary', query: {}, credential },
          1000,
          policy
        )
        assert.equal(result.ok, true)
        assert.ok(!JSON.stringify(result).includes(credential.value))
      }
    }
  )
})

test('orchestration refuses path escapes, unsafe credential headers and oversized requests before network', async () => {
  let requests = 0
  await withLocalServer(
    (_, response) => {
      requests += 1
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
    },
    async (origin) => {
      const policy = localPolicy(origin)
      for (const path of [
        '//evil',
        '/../admin',
        '/%2e%2e/admin',
        '/%252e%252e/admin',
        '/a%2fb',
        '/a\\b',
        '/a?b',
        '/a#b',
        '/a//b'
      ]) {
        const response = await executeUpstreamRequest(
          `${origin}/v1`,
          { method: 'GET', path, query: {} },
          1000,
          policy
        )
        assert.equal(response.code, 'invalid_url', path)
      }
      const invalidRequests: UpstreamExecutionRequest[] = [
        { method: 'GET' as const, path: '/safe', query: { q: 'line\nbreak' } },
        { method: 'GET' as const, path: '/safe', query: { q: 'x'.repeat(8200) } },
        {
          method: 'GET' as const,
          path: '/safe',
          query: Object.fromEntries(
            Array.from({ length: 5 }, (_, index) => [`field${index}`, 'x'.repeat(1800)])
          )
        },
        { method: 'GET' as const, path: '/safe', query: {}, body: { forbidden: true } },
        { method: 'POST' as const, path: '/safe', query: {}, body: { large: 'x'.repeat(65536) } },
        {
          method: 'POST' as const,
          path: '/safe',
          query: {},
          credential: { headerName: 'Cookie', value: 'secret' }
        },
        {
          method: 'POST' as const,
          path: '/safe',
          query: {},
          credential: { headerName: 'Accept-Encoding', value: 'gzip' }
        },
        {
          method: 'POST' as const,
          path: '/safe',
          query: {},
          credential: { headerName: 'X-Api-Key', value: 'bad\r\nHost: evil' }
        },
        {
          method: 'POST' as const,
          path: '/safe',
          query: {},
          credential: { headerName: 'Authorization', value: 'Bearer  two-spaces' }
        },
        {
          method: 'POST' as const,
          path: '/safe',
          query: {},
          credential: { headerName: 'X-Api-Key', value: ' trailing ' }
        },
        {
          method: 'POST' as const,
          path: '/safe',
          query: {},
          credential: { headerName: 'X-Api-Key', value: 'x'.repeat(8193) }
        },
        {
          method: 'POST' as const,
          path: '/safe',
          query: {},
          credential: { headerName: 'Authorization', value: `Bearer ${'x'.repeat(8193)}` }
        }
      ]
      for (const request of invalidRequests) {
        const response = await executeUpstreamRequest(origin, request, 1000, policy)
        assert.equal(response.ok, false)
      }
      assert.equal(requests, 0)
    }
  )
})

test('orchestration accepts a successful no-content response without requiring JSON', async () => {
  await withLocalServer(
    (_request, response) => response.writeHead(204).end(),
    async (origin) => {
      const result = await executeUpstreamRequest(
        origin,
        { method: 'DELETE', path: '/item', query: {} },
        1000,
        localPolicy(origin)
      )
      assert.equal(result.ok, true)
      assert.equal(result.statusCode, 204)
      assert.deepEqual(result.body, {})
    }
  )
})

test('orchestration bounds JSON response and never returns upstream error bodies', async () => {
  await withLocalServer(
    (request, response) => {
      switch (request.url) {
        case '/array':
          response.writeHead(200, { 'Content-Type': 'application/json' }).end('[{"id":"one"}]')
          break
        case '/error':
          response.writeHead(422, { 'Content-Type': 'application/json' }).end('{"secret":"hidden"}')
          break
        case '/compressed-error':
          response.writeHead(503, { 'Content-Encoding': 'gzip' }).end('hidden')
          break
        case '/text':
          response.writeHead(200, { 'Content-Type': 'text/plain' }).end('{}')
          break
        case '/primitive':
          response.writeHead(200, { 'Content-Type': 'application/json' }).end('42')
          break
        case '/invalid-utf8':
          response.writeHead(200, { 'Content-Type': 'application/json' }).end(Buffer.from([0xff]))
          break
        case '/compressed':
          response
            .writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' })
            .end('{}')
          break
        case '/large-json':
          response
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ value: 'x'.repeat(256 * 1024) }))
          break
        case '/redirect':
          response.writeHead(307, { Location: '/array' }).end()
          break
        default:
          response.writeHead(700).end('invalid')
      }
    },
    async (origin) => {
      const policy = localPolicy(origin)
      const check = (path: string) =>
        executeUpstreamRequest(origin, { method: 'GET', path, query: {} }, 1000, policy)
      const array = await check('/array')
      assert.equal(array.ok, true)
      assert.deepEqual(array.body, [{ id: 'one' }])
      const error = await check('/error')
      assert.deepEqual(
        { ok: error.ok, code: error.code, statusCode: error.statusCode, body: error.body },
        { ok: false, code: 'upstream_error', statusCode: 422, body: null }
      )
      assert.ok(!JSON.stringify(error).includes('hidden'))
      const compressedError = await check('/compressed-error')
      assert.equal(compressedError.code, 'upstream_error')
      assert.equal(compressedError.body, null)
      for (const path of ['/text', '/primitive', '/invalid-utf8', '/compressed']) {
        const response = await check(path)
        assert.equal(response.code, 'invalid_response', path)
        assert.equal(response.body, null)
      }
      assert.equal((await check('/large-json')).code, 'response_too_large')
      assert.equal((await check('/redirect')).code, 'redirect_blocked')
      assert.deepEqual(
        (({ code, statusCode }) => ({ code, statusCode }))(await check('/invalid-status')),
        { code: 'connection_failed', statusCode: null }
      )
    }
  )
})
