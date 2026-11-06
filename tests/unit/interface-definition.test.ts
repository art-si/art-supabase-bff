import assert from 'node:assert/strict'
import test from 'node:test'
import {
  interfaceInput,
  interfacePath,
  mappedFields,
  normalizeInterfaceDefinition,
  parseInterfaceSample,
  pointerSegments,
  stepPath,
  validateInterfaceDefinition
} from '../../server/interface-definition'
import { interfaceDto } from '../../server/interfaces'
import {
  inputBinding,
  interfaceFixture,
  interfaceRecordFixture,
  stepBinding
} from '../fixtures/interface-definition'

test('interface storage normalizes explicit fields and rejects unsafe executable definitions', () => {
  const sample = interfaceFixture()
  const normalized = interfaceInput({ ...sample, tenantId: 'forged', role: 'admin' })
  assert.ok(!('tenantId' in normalized) && !('role' in normalized))
  assert.deepEqual(validateInterfaceDefinition(normalized), [])
  assert.equal(interfacePath('/orders/'), '/orders')
  for (const path of [
    'https://example.test',
    '//outside.test',
    '/../orders',
    '/a/./b',
    '/a%2Fb',
    '/a?url=outside',
    '/a\\b'
  ])
    assert.throws(() => interfacePath(path))
  for (const pointer of ['/constructor/prototype', '/access_token', '/a~2b'])
    assert.throws(() => pointerSegments(pointer))
  assert.deepEqual(pointerSegments('/a~1b/~0name/0'), ['a/b', '~name', '0'])
  assert.throws(() =>
    normalizeInterfaceDefinition({
      ...sample.definition,
      steps: Array(9).fill(sample.definition.steps[0])
    })
  )
  assert.throws(() =>
    interfaceInput({
      ...sample,
      definition: {
        ...sample.definition,
        inputs: [{ ...sample.definition.inputs[0], key: 'password' }]
      }
    })
  )
})
test('semantic validation catches duplicate names, forward dependencies and inconsistent path bindings', () => {
  const sample = interfaceFixture()
  sample.definition.steps[0].pathParams = [stepBinding('orderId', 'customer', '/id')]
  sample.definition.inputs.push({ ...sample.definition.inputs[0] })
  sample.definition.steps[1].body = [inputBinding('unused', 'missing')]
  const issues = validateInterfaceDefinition(sample)
  assert.ok(issues.some((value) => value.includes('重复')))
  assert.ok(issues.some((value) => value.includes('前序')))
  assert.ok(issues.some((value) => value.includes('未声明')))
  assert.ok(issues.some((value) => value.includes('GET')))
})
test('typed samples and scalar mappings preserve booleans/numbers without evaluating code', () => {
  const sample = interfaceFixture()
  sample.definition.inputs.push(
    { key: 'quantity', label: '数量', location: 'query', type: 'number', required: true },
    { key: 'preview', label: '预览', location: 'query', type: 'boolean', required: true }
  )
  const input = parseInterfaceSample(sample.definition.inputs, {
    orderId: 'A/B',
    quantity: 0,
    preview: false
  })
  assert.equal(input.quantity, 0)
  assert.equal(input.preview, false)
  assert.throws(() =>
    parseInterfaceSample(sample.definition.inputs, { orderId: 'A', quantity: '1', preview: true })
  )
  assert.throws(() =>
    parseInterfaceSample(sample.definition.inputs, {
      orderId: 'A',
      quantity: 1,
      preview: true,
      secret: 'forged'
    })
  )
  assert.equal(stepPath(sample.definition.steps[0], { orderId: 'A B' }), '/orders/A%20B')
  assert.throws(() => stepPath(sample.definition.steps[0], { orderId: 'A/B' }))
  assert.throws(() => stepPath(sample.definition.steps[0], { orderId: '..' }))
  assert.deepEqual(
    mappedFields([stepBinding('name', 'customer', '/rows/0/name')], input, {
      customer: { rows: [{ name: '企业示例' }] }
    }),
    { name: '企业示例' }
  )
  assert.throws(() =>
    mappedFields([stepBinding('raw', 'customer', '')], input, { customer: { secret: 'private' } })
  )
})
test('interface public projection drops unexpected credentials and server-only authority', () => {
  const projected = interfaceDto({
    ...interfaceRecordFixture(),
    ciphertext: 'never-return',
    accessToken: 'never-return',
    serviceKey: 'never-return'
  })
  assert.ok(!JSON.stringify(projected).includes('never-return'))
  assert.equal(projected.definition.steps.length, 2)
})
