import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config } from '../../server/config'
import { database, requireData } from '../../server/database/client'
import { digest } from '../../server/security'

const origin = new URL(config.databaseUrl)
assert.equal(origin.origin, 'https://bksbwnxdurmuolygiofh.supabase.co', 'BFF-only verification')
assert.ok(config.databaseKey.length >= 16, 'Configure the server-side BFF database credential')
const issuer = 'https://session-refresh-fixture.invalid'
const members = [randomUUID(), randomUUID()]
const hashes = [digest(randomUUID()), digest(randomUUID())]
const oldPayload = 'sealed-isolated-refresh-fixture'
const payload = 'sealed-isolated-refresh-result'
const timeout = () => AbortSignal.timeout(8000)

async function claim(index: number, lease: string, expected = oldPayload) {
  const result = await database
    .rpc('bff_session_refresh_claim', {
      p_token_hash: hashes[index],
      p_payload: expected,
      p_lease: lease
    })
    .abortSignal(timeout())
  const value: unknown = requireData(result)
  assert.ok(isObjectRecord(value))
  return value
}
async function finish(index: number, lease: string, next: string | null, expected = oldPayload) {
  const result = await database
    .rpc('bff_session_refresh_finish', {
      p_token_hash: hashes[index],
      p_payload: expected,
      p_lease: lease,
      p_next_payload: next
    })
    .abortSignal(timeout())
  const value: unknown = requireData(result)
  assert.ok(isObjectRecord(value))
  return value
}

let failure: unknown
try {
  requireData(
    await database
      .from('bff_members')
      .insert(
        members.map((id) => ({
          id,
          issuer,
          subject: id,
          tenant_id: randomUUID(),
          role: 'viewer',
          enabled: true,
          display_name: '会话刷新隔离验证',
          email: ''
        }))
      )
      .select('id')
      .abortSignal(timeout())
  )
  requireData(
    await database
      .from('bff_sessions')
      .insert(
        hashes.map((hash, index) => ({
          token_hash: hash,
          member_id: members[index],
          payload: oldPayload,
          csrf_token: 'isolated-fixture',
          expires_at: '2099-01-01T00:00:00Z'
        }))
      )
      .select('token_hash')
      .abortSignal(timeout())
  )

  const leases = Array.from({ length: 16 }, () => randomUUID())
  const attempts = await Promise.all(leases.map((lease) => claim(0, lease)))
  const winner = attempts.findIndex((item) => item.status === 'claimed')
  assert.equal(attempts.filter((item) => item.status === 'claimed').length, 1)
  assert.ok(attempts.every((item, index) => index === winner || item.status === 'busy'))
  const leaseBefore: unknown = requireData(
    await database
      .from('bff_sessions')
      .select('refresh_lease_until')
      .eq('token_hash', hashes[0])
      .abortSignal(timeout())
      .single()
  )
  assert.equal((await claim(0, leases[winner])).status, 'claimed')
  const leaseAfter: unknown = requireData(
    await database
      .from('bff_sessions')
      .select('refresh_lease_until')
      .eq('token_hash', hashes[0])
      .abortSignal(timeout())
      .single()
  )
  assert.ok(isObjectRecord(leaseBefore) && isObjectRecord(leaseAfter))
  assert.equal(typeof leaseBefore.refresh_lease_until, 'string')
  assert.equal(leaseBefore.refresh_lease_until, leaseAfter.refresh_lease_until)
  const foreignLease = randomUUID()
  assert.equal((await claim(1, foreignLease)).status, 'claimed')
  assert.equal((await finish(0, leases[winner], payload)).status, 'updated')
  assert.deepEqual(await finish(0, leases[winner], null), { status: 'updated', payload })
  const independent: unknown = requireData(
    await database
      .from('bff_sessions')
      .select('payload')
      .eq('token_hash', hashes[1])
      .abortSignal(timeout())
      .single()
  )
  assert.ok(isObjectRecord(independent))
  assert.equal(independent.payload, oldPayload)

  requireData(
    await database
      .from('bff_sessions')
      .update({ refresh_lease_until: '2000-01-01T00:00:00Z' })
      .eq('token_hash', hashes[1])
      .select('token_hash')
      .abortSignal(timeout())
  )
  const successor = randomUUID()
  assert.equal((await claim(1, successor)).status, 'claimed')
  assert.equal((await finish(1, foreignLease, null)).status, 'busy')
  assert.equal((await finish(1, foreignLease, 'late-result')).status, 'busy')
  requireData(
    await database
      .from('bff_members')
      .update({ enabled: false })
      .eq('id', members[1])
      .select('id')
      .abortSignal(timeout())
  )
  assert.equal((await finish(1, successor, payload)).status, 'missing')

  const logoutLease = randomUUID()
  assert.equal((await claim(0, logoutLease, payload)).status, 'claimed')
  requireData(
    await database
      .from('bff_sessions')
      .delete()
      .eq('token_hash', hashes[0])
      .select('token_hash')
      .abortSignal(timeout())
  )
  assert.equal((await finish(0, logoutLease, 'resurrected', payload)).status, 'missing')
} catch (error) {
  failure = error
} finally {
  const sessions = await database
    .from('bff_sessions')
    .delete()
    .in('token_hash', hashes)
    .abortSignal(timeout())
  const profiles = await database
    .from('bff_members')
    .delete()
    .eq('issuer', issuer)
    .in('id', members)
    .abortSignal(timeout())
  if (sessions.error || profiles.error)
    failure = new AggregateError(
      [failure, sessions.error, profiles.error].filter(Boolean),
      '隔离会话验证清理失败'
    )
}
if (failure) throw failure
console.log(
  'Session refresh HTTP verification passed: one of 16 claims, CAS, tenant isolation, expiry takeover, disable, logout; fixtures removed.'
)
