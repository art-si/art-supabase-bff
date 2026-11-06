import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { runInterface } from '../../server/interface-runner'
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
  try {
    const result = await runInterface(
      interfaceRecordFixture(),
      { orderId: 'A 01' },
      async () => ({ baseUrl: `${origin}/v1`, timeoutMs: 2000 }),
      { allowedOrigins: [origin], allowedCidrs: [], allowLocalHttp: true, production: false }
    )
    assert.equal(result.passed, true, JSON.stringify(result))
    assert.deepEqual(result.output, { orderNo: 'DEMO-001', customerName: '示例客户' })
    assert.deepEqual(requests, ['/v1/orders/A%2001', '/v1/customers/C%2001'])
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
    const result = await runInterface(failed, { orderId: 'A' }, loader, policy)
    assert.equal(result.passed, false)
    assert.equal(calls, 1)
    assert.equal(result.steps[1].status, 'skipped')
    assert.ok(!JSON.stringify(result).includes('private-provider-body'))
    const echo = interfaceRecordFixture()
    echo.definition.outputs = [stepBinding('orderNo', 'order', '/orderNo')]
    const protectedResult = await runInterface(echo, { orderId: 'A' }, loader, policy)
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
      policy
    )
    assert.equal(preflight.passed, false)
    assert.equal(calls, before)
    assert.ok(preflight.steps.every((step) => step.status === 'skipped'))
  } finally {
    server.close()
    await once(server, 'close')
  }
})
