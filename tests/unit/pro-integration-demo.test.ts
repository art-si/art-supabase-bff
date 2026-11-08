import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { demoDefinition } from '../../scripts/pro-integration-demo'
import { validateInterfaceDefinition } from '../../server/interface-definition'

test('local Pro demo declares three valid two-column page contracts without provider credentials', () => {
  for (const kind of ['java', 'supabase', 'cloudbase'] as const) {
    const definition = demoDefinition(randomUUID(), randomUUID(), 1, kind, randomUUID())
    assert.deepEqual(validateInterfaceDefinition(definition), [])
    assert.equal(definition.method, 'GET')
    assert.equal(definition.definition.outputs.length, 0)
    assert.deepEqual(
      definition.definition.page?.fields.map((field) => field.target),
      ['id', 'name']
    )
    assert.equal(definition.definition.steps[0].pagination?.exactCount, kind === 'supabase')
    assert.equal(
      definition.definition.steps[0].responseContract?.mode,
      kind === 'supabase' ? undefined : 'business'
    )
    assert.ok(!JSON.stringify(definition).includes('credential'))
  }
})
