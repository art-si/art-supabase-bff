import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { config } from '../../server/config'
import { credentialKeyring } from '../../server/upstream-credentials'

const root = path.resolve(config.browserOutputDir)
const credentials = [config.clientSecret, config.sessionKey, config.databaseKey]
credentials.push(...credentialKeyring(config.credentialKeys, config.credentialKeyId).keys.values())
assert.ok(
  credentials.every((value) => value.length >= 16),
  'Configure real server credentials before checking the browser build'
)
let checked = 0
for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (!file.isFile() || !/\.(?:js|html|json|css|map)$/.test(file.name)) continue
  const source = readFileSync(path.join(file.parentPath, file.name), 'utf8')
  assert.ok(
    !credentials.some((credential) => source.includes(credential)),
    'A server credential was embedded in the browser build'
  )
  checked++
}
assert.ok(checked > 0, 'Build the browser application first')
console.log(`Verified ${checked} browser text assets: no configured server credentials embedded.`)
