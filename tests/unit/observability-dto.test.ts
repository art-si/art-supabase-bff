import assert from 'node:assert/strict'
import test from 'node:test'
import { callDto } from '../../server/observability'

const id = '11111111-1111-4111-8111-111111111111'

test('call DTO strips payloads, hashes, raw paths and credentials from legacy records', () => {
  const sensitive = 'top-secret-token'
  const safe = callDto({
    requestId: id,
    applicationId: id,
    applicationName: '测试应用',
    environment: 'development',
    interfaceId: id,
    interfaceName: '订单查询',
    versionNumber: 1,
    method: 'GET',
    pathTemplate: '/orders/{id}',
    startedAt: '2026-11-07T00:00:00Z',
    finishedAt: null,
    durationMs: null,
    status: 'running',
    httpStatus: null,
    errorCode: null,
    errorClass: null,
    inputHash: sensitive,
    idempotencyHash: sensitive,
    rawUrl: `https://example.test/${sensitive}`,
    rawBody: sensitive,
    steps: [
      {
        key: 'fetch',
        status: 'passed',
        statusCode: 200,
        durationMs: 12,
        responseBody: sensitive,
        credential: sensitive
      }
    ]
  })
  assert.equal(safe.errorClass, null)
  assert.equal(safe.steps[0].code, null)
  assert.equal(safe.steps[0].errorClass, null)
  assert.ok(!JSON.stringify(safe).includes(sensitive))
  assert.deepEqual(Object.keys(safe.steps[0]).sort(), [
    'code',
    'durationMs',
    'errorClass',
    'key',
    'status',
    'statusCode'
  ])
})

test('call DTO preserves only bounded stable codes and rejects invalid numeric data', () => {
  const row = {
    requestId: id,
    applicationId: id,
    applicationName: '测试应用',
    environment: 'production',
    interfaceId: id,
    interfaceName: '订单查询',
    versionNumber: 2,
    method: 'GET',
    pathTemplate: '/orders/{id}',
    startedAt: '2026-11-07T00:00:00Z',
    finishedAt: '2026-11-07T00:00:01Z',
    durationMs: 1000,
    status: 'failed',
    httpStatus: 502,
    errorCode: 'UPSTREAM_5XX',
    errorClass: 'upstream',
    steps: [
      {
        key: 'fetch',
        status: 'failed',
        statusCode: 503,
        durationMs: 950,
        code: 'UPSTREAM_FAILED_5XX',
        errorClass: 'upstream'
      }
    ]
  }
  const parsed = callDto(row)
  assert.equal(parsed.errorCode, 'UPSTREAM_5XX')
  assert.equal(parsed.steps[0].code, 'UPSTREAM_FAILED_5XX')
  assert.equal(callDto({ ...row, errorCode: 'raw-url-token' }).errorCode, null)
  assert.throws(() => callDto({ ...row, durationMs: -1 }), /Invalid observability number/)
  assert.throws(() => callDto({ ...row, httpStatus: 700 }), /Invalid observability number/)
  assert.throws(() => callDto({ ...row, versionNumber: 1.5 }), /Invalid observability number/)
  assert.throws(
    () => callDto({ ...row, steps: [{ ...row.steps[0], durationMs: -1 }] }),
    /Invalid observability number/
  )
})
