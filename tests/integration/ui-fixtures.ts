/** Temporary, disabled BFF-only membership rows for visual QA. Never grants access. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config } from '../../server/config'
import { database } from '../../server/database/client'

const bffHost = 'bksbwnxdurmuolygiofh.supabase.co'
const proIssuer = 'https://ckbftoopuyophiebamwy.supabase.co/auth/v1'
const fixtureIssuer = 'https://visual-fixture.invalid'
const fixturePath = path.resolve('.artifacts/ui/member-fixtures.json')
const fixtures = [
  {
    display_name: '验收示例：接口观察员',
    email: 'bff-visual-observer@example.test'
  },
  {
    display_name: '验收示例：服务维护员',
    email: 'bff-visual-maintainer@example.test'
  }
] as const
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface FixtureManifest {
  tenantId: string
  memberIds: [string, string]
}

function assertTarget(): void {
  if (
    !config.databaseUrl ||
    !config.databaseKey ||
    new URL(config.databaseUrl).hostname !== bffHost ||
    config.issuer !== proIssuer
  )
    throw new Error('Visual fixtures require the configured BFF database and pro issuer')
}

function readManifest(): FixtureManifest {
  const value: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'))
  if (
    !isObjectRecord(value) ||
    Object.keys(value).sort().join(',') !== 'memberIds,tenantId' ||
    typeof value.tenantId !== 'string' ||
    !uuidPattern.test(value.tenantId) ||
    !Array.isArray(value.memberIds) ||
    value.memberIds.length !== 2 ||
    !value.memberIds.every((id: unknown) => typeof id === 'string' && uuidPattern.test(id)) ||
    value.memberIds[0] === value.memberIds[1]
  )
    throw new Error('Fixture manifest is invalid; refusing to change members')
  return { tenantId: value.tenantId, memberIds: [value.memberIds[0], value.memberIds[1]] }
}

async function resolveAdminTenant(): Promise<string> {
  const result = await database
    .from('bff_members')
    .select('id,tenant_id')
    .eq('issuer', proIssuer)
    .eq('email', '869123771@qq.com')
    .eq('role', 'admin')
    .eq('enabled', true)
    .limit(2)
  if (result.error || result.data?.length !== 1 || !uuidPattern.test(result.data[0].tenant_id))
    throw new Error('Expected one active verified BFF administrator')
  return result.data[0].tenant_id
}

function assertFixtureRow(row: unknown, id: string, tenantId: string, index: number): void {
  const expected = fixtures[index]
  if (
    !isObjectRecord(row) ||
    row.id !== id ||
    row.issuer !== fixtureIssuer ||
    row.subject !== id ||
    row.tenant_id !== tenantId ||
    row.display_name !== expected.display_name ||
    row.email !== expected.email ||
    row.role !== 'viewer' ||
    row.enabled !== false
  )
    throw new Error('Fixture member differs from the recorded disabled row')
}

async function readFixtureRows(ids: string[]): Promise<unknown[]> {
  const result = await database
    .from('bff_members')
    .select('id,issuer,subject,tenant_id,display_name,email,role,enabled')
    .in('id', ids)
  if (result.error) throw new Error('Could not verify visual fixture members')
  return result.data ?? []
}

async function assertNoAccess(ids: string[]): Promise<void> {
  for (const table of ['bff_sessions', 'bff_member_roles', 'bff_application_members'] as const) {
    const result = await database.from(table).select('member_id').in('member_id', ids).limit(1)
    if (result.error || result.data?.length)
      throw new Error('Visual fixture has an access relationship; refusing to continue')
  }
}

async function apply(): Promise<number> {
  const tenantId = await resolveAdminTenant()
  let manifest: FixtureManifest
  if (existsSync(fixturePath)) {
    manifest = readManifest()
    if (manifest.tenantId !== tenantId)
      throw new Error('Fixture tenant no longer matches the verified administrator')
  } else {
    manifest = { tenantId, memberIds: [randomUUID(), randomUUID()] }
    mkdirSync(path.dirname(fixturePath), { recursive: true })
    writeFileSync(fixturePath, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
  }
  const rows = await readFixtureRows(manifest.memberIds)
  for (const [index, id] of manifest.memberIds.entries()) {
    const existing = rows.find((row) => isObjectRecord(row) && row.id === id)
    if (existing) {
      assertFixtureRow(existing, id, tenantId, index)
      continue
    }
    const result = await database.from('bff_members').insert({
      id,
      issuer: fixtureIssuer,
      subject: id,
      tenant_id: tenantId,
      display_name: fixtures[index].display_name,
      email: fixtures[index].email,
      role: 'viewer',
      enabled: false
    })
    if (result.error) throw new Error('Could not insert disabled visual fixture member')
  }
  const finalRows = await readFixtureRows(manifest.memberIds)
  if (finalRows.length !== 2) throw new Error('Visual fixture verification failed')
  for (const [index, id] of manifest.memberIds.entries()) {
    assertFixtureRow(
      finalRows.find((row) => isObjectRecord(row) && row.id === id),
      id,
      tenantId,
      index
    )
  }
  await assertNoAccess(manifest.memberIds)
  return finalRows.length
}

async function remove(): Promise<number> {
  if (!existsSync(fixturePath)) return 0
  const manifest = readManifest()
  const rows = await readFixtureRows(manifest.memberIds)
  for (const row of rows) {
    if (!isObjectRecord(row) || typeof row.id !== 'string')
      throw new Error('Fixture member could not be identified safely')
    const index = manifest.memberIds.indexOf(row.id)
    if (index < 0) throw new Error('Fixture member is not recorded')
    assertFixtureRow(row, manifest.memberIds[index], manifest.tenantId, index)
  }
  await assertNoAccess(manifest.memberIds)
  if (rows.length) {
    const result = await database
      .from('bff_members')
      .delete()
      .in('id', manifest.memberIds)
      .eq('issuer', fixtureIssuer)
      .eq('tenant_id', manifest.tenantId)
      .select('id')
    if (result.error || result.data?.length !== rows.length)
      throw new Error('Visual fixture removal did not match recorded members')
  }
  if ((await readFixtureRows(manifest.memberIds)).length)
    throw new Error('Visual fixture removal verification failed')
  unlinkSync(fixturePath)
  return rows.length
}

assertTarget()
const action = process.argv[2]
if (action !== 'apply' && action !== 'remove') throw new Error('Use apply or remove')
const count = action === 'apply' ? await apply() : await remove()
console.log(`${action}: ${count}`)
