import assert from 'node:assert/strict'
import test from 'node:test'
import { upstreamDto, upstreamInput } from '../../server/upstreams'

test('upstream metadata preparation rejects unsafe URLs and transport headers, and drops caller authority', () => {
  const input = {
    applicationId: '11111111-1111-4111-8111-111111111111',
    code: 'example-service',
    name: '示例服务',
    description: '',
    environment: 'development',
    baseUrl: 'https://service.example.test/api/',
    authType: 'none',
    headerName: '',
    timeoutMs: 5000,
    tenantId: 'forged',
    role: 'admin',
    credential: 'never-metadata'
  }
  const parsed = upstreamInput(input, true)
  assert.equal(parsed.baseUrl, 'https://service.example.test/api')
  assert.ok(
    !Object.hasOwn(parsed, 'tenantId') &&
      !Object.hasOwn(parsed, 'role') &&
      !Object.hasOwn(parsed, 'credential')
  )
  for (const baseUrl of [
    'https://user:secret@service.example.test',
    'https://service.example.test?token=secret',
    'https://service.example.test/#fragment',
    'http://169.254.169.254/'
  ])
    assert.throws(() => upstreamInput({ ...input, baseUrl }, true))
  for (const headerName of ['Host', 'Cookie', 'Authorization', 'Content-Length', 'X-Forwarded-For'])
    assert.throws(() => upstreamInput({ ...input, authType: 'api_key_header', headerName }, true))
  assert.equal(upstreamInput({ ...input, authType: 'bearer' }, true).headerName, 'Authorization')
})
test('upstream public projection never forwards unexpected credential data or raw provider messages', () => {
  const record = {
    id: 'service',
    applicationId: 'app',
    application: {
      id: 'app',
      code: 'demo',
      name: '示例应用',
      enabled: true,
      ciphertext: 'application-secret'
    },
    code: 'demo-service',
    name: '示例服务',
    description: '',
    environment: 'development',
    status: 'draft',
    baseUrl: 'https://example.test/',
    authType: 'none',
    headerName: '',
    timeoutMs: 5000,
    version: 1,
    configVersion: 1,
    credentialConfigured: false,
    credentialVersion: 0,
    healthStatus: 'unknown',
    lastCheckedAt: null,
    lastStatusCode: null,
    lastDurationMs: null,
    lastHealthCode: 'raw-secret-provider-error',
    createdAt: '2026-11-07T00:00:00Z',
    updatedAt: '2026-11-07T00:00:00Z',
    ciphertext: 'ciphertext-secret',
    credential: 'plaintext-secret',
    keyId: 'private-key-id'
  }
  const dto = upstreamDto(record),
    serialized = JSON.stringify(dto)
  for (const forbidden of [
    'application-secret',
    'raw-secret-provider-error',
    'ciphertext-secret',
    'plaintext-secret',
    'private-key-id'
  ])
    assert.ok(!serialized.includes(forbidden))
  assert.equal(
    upstreamDto({ ...record, lastHealthCode: 'toString' }).lastHealthMessage,
    '尚未完成连接测试'
  )
  assert.match(upstreamDto({ ...record, stale: true }).lastHealthMessage, /旧结果未应用/)
  assert.throws(() => upstreamDto({ ...record, application: null }))
})
