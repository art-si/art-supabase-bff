import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { resolveBffOrigin } from '../../server/config'

const configUrl = new URL('../../server/config.ts', import.meta.url).href
function readConfig(overrides: NodeJS.ProcessEnv, cwd = process.cwd()) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const { config } = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ port: config.port, host: config.host, origin: config.origin }))`
      ],
      { env: { ...process.env, ...overrides }, cwd, encoding: 'utf8' }
    )
  )
}

test('Render uses its assigned port and HTTPS origin while local defaults stay private', () => {
  assert.deepEqual(
    readConfig({
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
    readConfig({
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

test('server env files retain mode precedence and expansion without importing the build tool', () => {
  const artifacts = path.resolve('.artifacts')
  mkdirSync(artifacts, { recursive: true })
  const fixture = mkdtempSync(path.join(artifacts, 'server-env-'))
  const files = {
    '.env':
      'BFF_PORT=3011\nBFF_ORIGIN=https://${BFF_TEST_ORIGIN_HOST}\nBFF_TEST_ORIGIN_HOST=base.example.com\n',
    '.env.local': 'BFF_TEST_ORIGIN_HOST=local.example.com\n',
    '.env.production': 'BFF_PORT=3012\nBFF_TEST_ORIGIN_HOST=mode.example.com\n',
    '.env.production.local': 'BFF_TEST_ORIGIN_HOST=final.example.com\n'
  }
  const overrides: NodeJS.ProcessEnv = {
    NODE_ENV: 'production',
    BFF_PORT: undefined,
    PORT: undefined,
    BFF_HOST: undefined,
    BFF_ORIGIN: undefined,
    BFF_TEST_ORIGIN_HOST: undefined,
    RENDER_EXTERNAL_URL: undefined
  }
  try {
    for (const [name, contents] of Object.entries(files))
      writeFileSync(path.join(fixture, name), contents)
    assert.deepEqual(readConfig(overrides, fixture), {
      port: 3012,
      host: '127.0.0.1',
      origin: 'https://final.example.com'
    })
    assert.deepEqual(
      readConfig(
        { ...overrides, BFF_PORT: '3099', BFF_ORIGIN: 'https://override.example.com' },
        fixture
      ),
      {
        port: 3099,
        host: '127.0.0.1',
        origin: 'https://override.example.com'
      }
    )
  } finally {
    for (const name of Object.keys(files)) unlinkSync(path.join(fixture, name))
    rmdirSync(fixture)
  }
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
