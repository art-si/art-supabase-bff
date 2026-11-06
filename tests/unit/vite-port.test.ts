import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import createConfig from '../../vite.config'

test('the frontend follows the BFF environment port without exposing private settings', async () => {
  const root = path.resolve(import.meta.dirname, '../..')
  const mode = `port-contract-${randomUUID()}`
  const fixture = path.join(root, `.env.${mode}.local`)
  const originalPort = process.env.BFF_PORT
  assert.ok(!existsSync(fixture))
  writeFileSync(fixture, 'BFF_PORT=3097\nBFF_SUPABASE_SERVICE_KEY=private-port-fixture\n', {
    flag: 'wx'
  })
  try {
    delete process.env.BFF_PORT
    const fileConfig = await createConfig({ mode, command: 'serve' })
    assert.equal(fileConfig.server?.port, 3097)
    assert.ok(fileConfig.cacheDir?.endsWith(path.join('bff', '3097')))
    assert.ok(!JSON.stringify(fileConfig.define).includes('private-port-fixture'))
    process.env.BFF_PORT = '3098'
    const processConfig = await createConfig({ mode, command: 'serve' })
    assert.equal(processConfig.server?.port, 3098)
    assert.notEqual(fileConfig.cacheDir, processConfig.cacheDir)
  } finally {
    if (originalPort === undefined) delete process.env.BFF_PORT
    else process.env.BFF_PORT = originalPort
    assert.equal(path.dirname(fixture), root)
    unlinkSync(fixture)
  }
})
