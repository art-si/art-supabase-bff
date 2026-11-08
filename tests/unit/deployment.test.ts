import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { resolveBffOrigin } from '../../server/config'

test('Render uses its assigned port and HTTPS origin while local defaults stay private', () => {
  const read = (overrides: NodeJS.ProcessEnv) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          "const { config } = await import('./server/config.ts'); console.log(JSON.stringify({ port: config.port, host: config.host, origin: config.origin }))"
        ],
        { env: { ...process.env, ...overrides }, encoding: 'utf8' }
      )
    )
  assert.deepEqual(
    read({
      NODE_ENV: 'production',
      BFF_PORT: '',
      PORT: '10000',
      BFF_HOST: '0.0.0.0',
      BFF_ORIGIN: '',
      RENDER_EXTERNAL_URL: 'https://bff-test.onrender.com'
    }),
    { port: 10000, host: '0.0.0.0', origin: 'https://bff-test.onrender.com' }
  )
  assert.deepEqual(
    read({
      NODE_ENV: 'development',
      BFF_PORT: '3097',
      PORT: '10000',
      BFF_HOST: '',
      BFF_ORIGIN: 'http://localhost:3097',
      RENDER_EXTERNAL_URL: ''
    }),
    { port: 3097, host: '127.0.0.1', origin: 'http://localhost:3097' }
  )
})

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
