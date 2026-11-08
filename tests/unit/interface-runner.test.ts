import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  classifyExecutionCode,
  classifyExecutionError,
  projectInterfacePage,
  runInterface
} from '../../server/interface-runner'
import type { InterfaceStepTarget } from '../../server/interface-runner'
import { HttpError } from '../../server/http'
import { interfaceRecordFixture, stepBinding } from '../fixtures/interface-definition'

test('composition executes dependent calls, preserves base prefixes and exposes only mapped output', async () => {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url || '')
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify(
        req.url?.startsWith('/v1/orders/')
          ? { orderNo: 'DEMO-001', customerId: 'C 01', internal: 'never-return' }
          : { name: '示例客户', internal: 'never-return' }
      )
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  let batchChecks = 0
  let executionChecks = 0
  try {
    const result = await runInterface(
      interfaceRecordFixture(),
      { orderId: 'A 01' },
      async () => {
        executionChecks += 1
        return { baseUrl: `${origin}/v1`, timeoutMs: 2000 }
      },
      {
        policy: {
          allowedOrigins: [origin],
          allowedCidrs: [],
          allowLocalHttp: true,
          production: false
        },
        preflight: async (steps) => {
          batchChecks += 1
          return steps.map(() => ({ baseUrl: `${origin}/v1`, timeoutMs: 2000 }))
        }
      }
    )
    assert.equal(result.passed, true, JSON.stringify(result))
    assert.deepEqual(result.output, { orderNo: 'DEMO-001', customerName: '示例客户' })
    assert.deepEqual(requests, ['/v1/orders/A%2001', '/v1/customers/C%2001'])
    assert.equal(batchChecks, 1)
    assert.equal(executionChecks, 2)
    assert.ok(!JSON.stringify(result).includes('never-return'))
  } finally {
    server.close()
    await once(server, 'close')
  }
})
test('upstream failures stop following requests and credential echoes cannot escape output mapping', async () => {
  let calls = 0
  const secret = 'isolated-runtime-secret'
  const server = createServer((req, res) => {
    calls++
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/fail') {
      res.statusCode = 503
      res.end(JSON.stringify({ debug: 'private-provider-body' }))
    } else {
      assert.equal(req.headers.authorization, `Bearer ${secret}`)
      res.end(JSON.stringify({ orderNo: secret, customerId: 'C01', name: '客户' }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const policy = {
    allowedOrigins: [origin],
    allowedCidrs: [],
    allowLocalHttp: true,
    production: false
  }
  const loader = async (): Promise<InterfaceStepTarget> => ({
    baseUrl: origin,
    timeoutMs: 2000,
    credential: { headerName: 'Authorization', value: `Bearer ${secret}` }
  })
  try {
    const failed = interfaceRecordFixture()
    failed.definition.steps[0].path = '/fail'
    failed.definition.steps[0].pathParams = []
    const result = await runInterface(failed, { orderId: 'A' }, loader, { policy })
    assert.equal(result.passed, false)
    assert.equal(result.errorClass, 'upstream')
    assert.equal(result.steps[0].code, 'upstream_error')
    assert.equal(calls, 1)
    assert.equal(result.steps[1].status, 'skipped')
    assert.ok(!JSON.stringify(result).includes('private-provider-body'))
    const echo = interfaceRecordFixture()
    echo.definition.outputs = [stepBinding('orderNo', 'order', '/orderNo')]
    const protectedResult = await runInterface(echo, { orderId: 'A' }, loader, { policy })
    assert.equal(protectedResult.passed, false)
    assert.deepEqual(protectedResult.output, {})
    assert.ok(!JSON.stringify(protectedResult).includes(secret))
    const before = calls
    const preflight = await runInterface(
      interfaceRecordFixture(),
      { orderId: 'A' },
      async () => {
        throw new HttpError(409, '上游服务尚未启用')
      },
      { policy }
    )
    assert.equal(preflight.passed, false)
    assert.equal(calls, before)
    assert.ok(preflight.steps.every((step) => step.status === 'skipped'))
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('stable network and HTTP codes determine error categories without inspecting messages', () => {
  assert.equal(classifyExecutionCode('timeout'), 'timeout')
  assert.equal(classifyExecutionCode('upstream_error', 401), 'authorization')
  assert.equal(classifyExecutionCode('upstream_error', 429), 'rate_limited')
  assert.equal(classifyExecutionCode('upstream_error', 422), 'validation')
  assert.equal(classifyExecutionCode('upstream_error', 503), 'upstream')
  assert.equal(classifyExecutionCode('dns_failed'), 'unknown')
  assert.equal(classifyExecutionError(new HttpError(504, 'arbitrary')), 'timeout')
  assert.equal(classifyExecutionError(new HttpError(409, 'arbitrary', 'RESULT_UNKNOWN')), 'unknown')
})

test('page projection keeps only declared rows and requires a verified total', () => {
  const page = {
    stepKey: 'load',
    recordsPointer: '/records',
    totalSource: 'content-range' as const,
    totalPointer: '',
    currentInputKey: 'current',
    sizeInputKey: 'size',
    fields: [
      { target: 'id', label: '编号', pointer: '/id', type: 'string' as const, required: true },
      {
        target: 'quantity',
        label: '数量',
        pointer: '/quantity',
        type: 'number' as const,
        required: false
      }
    ]
  }
  const source = {
    records: [
      { id: 'A', quantity: 2, privateKey: 'never-return' },
      { id: 'B', privateKey: 'never-return' }
    ]
  }
  const result = projectInterfacePage(page, source, '0-1/2', { current: 1, size: 2 })
  assert.deepEqual(result, {
    records: [
      { id: 'A', quantity: 2 },
      { id: 'B', quantity: null }
    ],
    total: 2,
    current: 1,
    size: 2
  })
  assert.ok(!JSON.stringify(result).includes('never-return'))
  assert.throws(() => projectInterfacePage(page, source, '0-1/*', { current: 1, size: 2 }))
  assert.throws(() => projectInterfacePage(page, source, '0-1/2', { current: 1, size: 101 }))
  assert.throws(
    () => projectInterfacePage(page, source, '0-1/2', { current: 1, size: 1 }),
    (error: unknown) => error instanceof HttpError && error.code === 'INVALID_PAGE_RESULT'
  )
  assert.throws(() =>
    projectInterfacePage(page, source, '0-1/2', { current: 1, size: 2 }, (value) => value === 'A')
  )
  assert.throws(() =>
    projectInterfacePage(page, { records: Array(101).fill({ id: 'A' }) }, '0-100/101', {
      current: 1,
      size: 100
    })
  )
})

test('paginated GET derives controlled offset and returns only declared rows', async () => {
  const received: string[] = []
  const server = createServer((request, response) => {
    received.push(`${request.url}|${request.headers.prefer}`)
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Range': '0-1/2' })
    response.end(
      JSON.stringify([
        { name: '示例甲', privateValue: 'never-return' },
        { name: '示例乙', privateValue: 'never-return' }
      ])
    )
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const definition = interfaceRecordFixture()
    definition.path = '/items'
    definition.definition.inputs = [
      { key: 'current', label: '页码', location: 'query', type: 'number', required: true },
      { key: 'size', label: '页长', location: 'query', type: 'number', required: true }
    ]
    definition.definition.steps = [
      {
        ...definition.definition.steps[0],
        key: 'load',
        method: 'GET',
        path: '/items',
        pathParams: [],
        query: [],
        body: [],
        pagination: {
          mode: 'offset',
          currentInputKey: 'current',
          sizeInputKey: 'size',
          pageParameter: 'offset',
          sizeParameter: 'limit',
          exactCount: true
        }
      }
    ]
    definition.definition.outputs = []
    definition.definition.page = {
      stepKey: 'load',
      recordsPointer: '',
      totalSource: 'content-range',
      totalPointer: '',
      currentInputKey: 'current',
      sizeInputKey: 'size',
      fields: [{ target: 'name', label: '名称', pointer: '/name', type: 'string', required: true }]
    }
    const result = await runInterface(
      definition,
      { current: 1, size: 2 },
      async () => ({ baseUrl: origin, timeoutMs: 2000 }),
      {
        policy: {
          allowedOrigins: [origin],
          allowedCidrs: [],
          allowLocalHttp: true,
          production: false
        }
      }
    )
    assert.equal(result.passed, true, JSON.stringify(result))
    assert.deepEqual(result.output, {
      records: [{ name: '示例甲' }, { name: '示例乙' }],
      total: 2,
      current: 1,
      size: 2
    })
    assert.deepEqual(received, ['/items?offset=0&limit=2|count=exact'])
    assert.ok(!JSON.stringify(result).includes('never-return'))
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('HTTP 200 business failure stops composition without exposing provider data', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ code: 4001, data: { secret: 'never-return' } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const definition = interfaceRecordFixture()
    definition.definition.steps = [
      {
        ...definition.definition.steps[0],
        path: '/error',
        pathParams: [],
        query: [],
        body: [],
        responseContract: {
          mode: 'business',
          codePointer: '/code',
          dataPointer: '/data',
          successCodes: [0]
        }
      }
    ]
    definition.definition.outputs = [
      stepBinding('value', definition.definition.steps[0].key, '/secret')
    ]
    const result = await runInterface(
      definition,
      { orderId: 'A' },
      async () => ({ baseUrl: origin, timeoutMs: 2000 }),
      {
        policy: {
          allowedOrigins: [origin],
          allowedCidrs: [],
          allowLocalHttp: true,
          production: false
        }
      }
    )
    assert.equal(result.passed, false)
    assert.equal(result.steps[0].code, 'business_error')
    assert.deepEqual(result.output, {})
    assert.ok(!JSON.stringify(result).includes('never-return'))
  } finally {
    server.close()
    await once(server, 'close')
  }
})
