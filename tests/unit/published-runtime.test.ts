import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { decodePublishedTarget } from '../../server/published-runtime'
import { interfaceFixture } from '../fixtures/interface-definition'

const member = { tenant_id: '17ea39b4-e369-40da-a961-4c6c71066bc0' }
const definition = interfaceFixture()
const execution = { applicationId: definition.applicationId, environment: definition.environment }
const step = definition.definition.steps[0]
const snapshot = {
  stepKey: step.key,
  id: step.upstreamId,
  configVersion: step.configVersion,
  currentConfigVersion: step.configVersion,
  credentialVersion: 0,
  baseUrl: 'https://example.test/v1',
  timeoutMs: 2000,
  authType: 'none',
  headerName: '',
  credential: null
}
const policy = {
  allowedOrigins: ['https://example.test'],
  allowedCidrs: [],
  allowLocalHttp: false,
  production: false
}

test('authorized published snapshot decodes to a bounded target and public version observation', () => {
  const target = decodePublishedTarget(member, execution, step, snapshot, false, policy)
  assert.equal(target.baseUrl, 'https://example.test/v1')
  assert.equal(target.timeoutMs, 2000)
  assert.equal(target.credential, undefined)
  assert.deepEqual(target.observed, {
    id: step.upstreamId,
    configVersion: step.configVersion,
    currentConfigVersion: step.configVersion,
    credentialVersion: 0
  })
})

test('published target decoder rejects step substitution and stale current configuration', () => {
  assert.throws(() =>
    decodePublishedTarget(member, execution, step, { ...snapshot, stepKey: 'other' }, false, policy)
  )
  assert.throws(() =>
    decodePublishedTarget(member, execution, step, { ...snapshot, id: randomUUID() }, false, policy)
  )
  assert.throws(() =>
    decodePublishedTarget(
      member,
      execution,
      step,
      { ...snapshot, timeoutMs: 30_001 },
      false,
      policy
    )
  )
  assert.throws(() =>
    decodePublishedTarget(
      member,
      execution,
      step,
      { ...snapshot, currentConfigVersion: 2 },
      true,
      policy
    )
  )
})
