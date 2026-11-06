import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import {
  normalizeUpstreamUrl,
  probeUpstream,
  validateUpstreamPolicy,
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
