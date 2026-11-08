import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Session } from '../../server/auth'
import {
  gatewayInputHash,
  gatewayStepCode,
  openGatewayReplay,
  parseGatewayInput,
  parseGatewayRoute,
  sealGatewayReplay,
  selectPublishedCandidate
} from '../../server/gateway'
import type { PublishedExecution } from '../../src/types/release'
import { interfaceFixture } from '../fixtures/interface-definition'

const key = Buffer.alloc(32, 17).toString('base64')
const otherKey = Buffer.alloc(32, 18).toString('base64')

test('gateway log step codes use the SQL-safe stable uppercase vocabulary', () => {
  assert.equal(gatewayStepCode('upstream_error'), 'UPSTREAM_ERROR')
  assert.equal(gatewayStepCode('timeout'), 'TIMEOUT')
  assert.equal(gatewayStepCode('FORBIDDEN'), 'FORBIDDEN')
  assert.equal(gatewayStepCode('bad-code'), 'STEP_FAILED')
  assert.equal(gatewayStepCode(null), null)
})

function published(overrides: Partial<PublishedExecution> = {}): PublishedExecution {
  const definition = interfaceFixture()
  return {
    ...definition,
    interfaceId: randomUUID(),
    versionId: randomUUID(),
    versionNumber: 1,
    deploymentVersion: 1,
    ...overrides
  }
}

function session(): Session {
  return {
    member: {
      id: randomUUID(),
      issuer: 'https://identity.example.test/auth/v1',
      subject: randomUUID(),
      tenant_id: randomUUID(),
      display_name: '隔离测试成员',
      email: 'gateway-test@example.invalid',
      role: 'viewer',
      enabled: true
    },
    row: {
      token_hash: 'synthetic',
      member_id: 'synthetic',
      payload: 'synthetic',
      csrf_token: 'synthetic',
      expires_at: '2099-01-01T00:00:00Z'
    },
    tokens: {
      accessToken: 'synthetic',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
      subject: 'synthetic'
    }
  }
}

test('route parser rejects ambiguous or unsafe gateway URLs before database routing', () => {
  assert.deepEqual(
    (({ appCode, environment, path, method }) => ({ appCode, environment, path, method }))(
      parseGatewayRoute({
        url: '/api/gateway/demo-app/development/orders/A%2001?include=true',
        method: 'GET'
      })
    ),
    { appCode: 'demo-app', environment: 'development', path: '/orders/A%2001', method: 'GET' }
  )
  for (const url of [
    '/api/gateway/demo-app/development/orders/%2Fadmin',
    '/api/gateway/demo-app/development/orders/%252e%252e',
    '/api/gateway/demo-app/development/orders/%2e%2e',
    '/api/gateway/demo-app/development/orders/a//b',
    '/api/gateway/demo-app/development/orders/A?x=%GG',
    '/api/gateway/demo-app/unknown/orders/A',
    '/api/gateway/demo-app/development'
  ]) {
    assert.throws(() => parseGatewayRoute({ url, method: 'GET' }), url)
  }
  assert.throws(() =>
    parseGatewayRoute({ url: '/api/gateway/demo-app/development/x', method: 'HEAD' })
  )
})

test('published route selection gives static segments priority and supports partial placeholders', () => {
  const dynamic = published({ path: '/orders/{orderId}' })
  const staticRoute = published({ path: '/orders/new' })
  const partial = published({ path: '/order-{orderId}' })
  const list = [dynamic, partial, staticRoute]
  assert.equal(
    selectPublishedCandidate(list, '/orders/new')?.published.interfaceId,
    staticRoute.interfaceId
  )
  assert.deepEqual(selectPublishedCandidate(list, '/orders/A%2001')?.pathParams, {
    orderId: 'A 01'
  })
  assert.deepEqual(selectPublishedCandidate(list, '/order-A%2001')?.pathParams, { orderId: 'A 01' })
  assert.equal(selectPublishedCandidate(list, '/orders/missing/extra'), null)
  assert.equal(selectPublishedCandidate([published({ path: '/{id}-{id}' })], '/A-B'), null)
})

test('gateway input is typed by the immutable snapshot and rejects unknown or repeated fields', () => {
  const candidate = published()
  candidate.definition.inputs.push(
    { key: 'size', label: '数量', location: 'query', type: 'number', required: true },
    { key: 'flag', label: '标记', location: 'query', type: 'boolean', required: false },
    { key: 'weight', label: '重量', location: 'body', type: 'number', required: true }
  )
  const values = parseGatewayInput(
    candidate,
    { orderId: 'A 01' },
    new URLSearchParams('size=12.5&flag=true'),
    { weight: 2 }
  )
  assert.deepEqual(values, { orderId: 'A 01', size: 12.5, flag: true, weight: 2 })
  for (const [query, body] of [
    ['size=1&size=2', { weight: 2 }],
    ['size=1e3', { weight: 2 }],
    ['size=2&extra=1', { weight: 2 }],
    ['size=2', { weight: 2, credential: 'forbidden' }],
    ['', { weight: 2 }]
  ] as const) {
    assert.throws(() =>
      parseGatewayInput(candidate, { orderId: 'A' }, new URLSearchParams(query), body)
    )
  }
})

test('idempotency input hash is stable for JSON key order and changes with version or values', () => {
  const candidate = published()
  candidate.definition.inputs.push({
    key: 'include',
    label: '关联范围',
    location: 'query',
    type: 'string',
    required: false
  })
  const first = gatewayInputHash(candidate, { orderId: 'A', include: 'customer' })
  assert.equal(first, gatewayInputHash(candidate, { include: 'customer', orderId: 'A' }))
  assert.notEqual(first, gatewayInputHash(candidate, { orderId: 'B', include: 'customer' }))
  assert.notEqual(
    first,
    gatewayInputHash(
      { ...candidate, versionId: randomUUID() },
      { orderId: 'A', include: 'customer' }
    )
  )
})

test('replay payload uses a separate key and binds tenant, member, application, call and version', () => {
  const actor = session()
  const candidate = published()
  const response = {
    requestId: randomUUID(),
    version: candidate.versionNumber,
    data: { orderNo: 'A 01' }
  }
  const ciphertext = sealGatewayReplay(actor, candidate, response, key)
  assert.ok(!ciphertext.includes('A 01'))
  assert.deepEqual(
    openGatewayReplay(actor, candidate, response.requestId, ciphertext, key),
    response
  )
  assert.throws(() => openGatewayReplay(actor, candidate, response.requestId, ciphertext, otherKey))
  assert.throws(() => openGatewayReplay(actor, candidate, randomUUID(), ciphertext, key))
  assert.throws(() =>
    openGatewayReplay(
      { ...actor, member: { ...actor.member, id: randomUUID() } },
      candidate,
      response.requestId,
      ciphertext,
      key
    )
  )
  assert.throws(() =>
    openGatewayReplay(
      actor,
      { ...candidate, versionId: randomUUID() },
      response.requestId,
      ciphertext,
      key
    )
  )
  assert.throws(() =>
    openGatewayReplay(
      actor,
      { ...candidate, deploymentVersion: 2 },
      response.requestId,
      ciphertext,
      key
    )
  )
  assert.throws(() =>
    openGatewayReplay(
      actor,
      { ...candidate, applicationId: randomUUID() },
      response.requestId,
      ciphertext,
      key
    )
  )
})

test('encrypted replay accepts bounded declared pages and rejects extra row fields', () => {
  const actor = session()
  const candidate = published()
  candidate.definition.outputs = []
  candidate.definition.page = {
    stepKey: 'load',
    recordsPointer: '',
    totalSource: 'content-range',
    totalPointer: '',
    currentInputKey: 'current',
    sizeInputKey: 'size',
    fields: [{ target: 'name', label: '名称', pointer: '/name', type: 'string', required: true }]
  }
  const response = {
    requestId: randomUUID(),
    version: candidate.versionNumber,
    code: 200 as const,
    msg: '成功',
    data: { records: [{ name: '示例甲' }, { name: '示例乙' }], total: 2, current: 1, size: 2 }
  }
  const ciphertext = sealGatewayReplay(actor, candidate, response, key)
  assert.deepEqual(
    openGatewayReplay(actor, candidate, response.requestId, ciphertext, key),
    response
  )
  const unsafe = {
    ...response,
    data: { ...response.data, records: [{ name: '示例甲', secret: 'never' }] }
  }
  const unsafeCipher = sealGatewayReplay(actor, candidate, unsafe, key)
  assert.throws(() => openGatewayReplay(actor, candidate, response.requestId, unsafeCipher, key))
})
