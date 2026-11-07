import assert from 'node:assert/strict'
import test from 'node:test'
import {
  releaseCommandInput,
  releaseDefinitionIssues,
  releaseHistoryDto,
  releaseRecordDto
} from '../../server/releases'
import { interfaceFixture, interfaceRecordFixture } from '../fixtures/interface-definition'

function record() {
  const fixture = interfaceRecordFixture()
  return {
    interfaceId: fixture.id,
    applicationId: fixture.applicationId,
    application: fixture.application,
    environment: fixture.environment,
    code: fixture.code,
    name: fixture.name,
    description: fixture.description,
    draftVersion: 1,
    draftMethod: fixture.method,
    draftPath: fixture.path,
    validationStatus: 'valid',
    lastTestStatus: 'passed',
    lastTestVersion: 1,
    versionCount: 1,
    deployment: {
      version: 1,
      enabled: true,
      activeVersionId: fixture.id,
      activeVersionNumber: 1,
      method: fixture.method,
      path: fixture.path,
      updatedAt: fixture.updatedAt,
      updatedByName: '测试维护员'
    }
  }
}

test('release public projections omit execution credentials and reject inconsistent ownership', () => {
  const sample = record()
  const response = releaseHistoryDto({
    record: { ...sample, credential: 'must-not-leak' },
    versions: [
      {
        ...interfaceFixture(),
        id: sample.interfaceId,
        interfaceId: sample.interfaceId,
        number: 1,
        draftVersion: 1,
        checksum: 'a'.repeat(64),
        notes: '首次发布',
        createdAt: sample.deployment.updatedAt,
        createdByName: '测试维护员',
        upstreams: [{ payload: 'secret' }],
        credentialVersion: 2
      }
    ],
    events: [],
    versionsTotal: 1,
    eventsTotal: 0,
    versionPage: 1,
    eventPage: 1,
    size: 20,
    resultPayload: 'private-cipher'
  })
  const serialized = JSON.stringify(response)
  for (const forbidden of [
    'credential',
    'must-not-leak',
    'upstreams',
    'private-cipher',
    'resultPayload'
  ])
    assert.ok(!serialized.includes(forbidden))
  assert.throws(() => releaseRecordDto({ ...sample, applicationId: sample.interfaceId }))
  assert.throws(() =>
    releaseRecordDto({ ...sample, deployment: { ...sample.deployment, version: 0 } })
  )
})

test('release commands require explicit CAS and notes while ignoring forged scope', () => {
  assert.deepEqual(
    releaseCommandInput(
      {
        deploymentVersion: 0,
        draftVersion: 2,
        notes: ' 首次发布 ',
        tenantId: 'forged',
        createdBy: 'forged'
      },
      'publish'
    ),
    { deploymentVersion: 0, draftVersion: 2, notes: '首次发布' }
  )
  for (const deploymentVersion of [undefined, -1, 1.2, '1'])
    assert.throws(() =>
      releaseCommandInput({ deploymentVersion, draftVersion: 1, notes: '发布' }, 'publish')
    )
  for (const notes of ['', '  ', 'a'.repeat(1001)])
    assert.throws(() => releaseCommandInput({ deploymentVersion: 1, notes }, 'disable'))
  const targetVersionId = interfaceRecordFixture().id.toUpperCase()
  assert.equal(
    releaseCommandInput({ deploymentVersion: 2, targetVersionId, notes: '回滚' }, 'rollback')
      .targetVersionId,
    targetVersionId.toLowerCase()
  )
})

test('published GET endpoints cannot hide mutating upstream steps', () => {
  const draft = interfaceFixture()
  draft.definition.steps[0].method = 'POST'
  assert.ok(releaseDefinitionIssues(draft).some((issue) => issue.includes('GET 入口')))
  draft.method = 'POST'
  assert.deepEqual(releaseDefinitionIssues(draft), [])
})
