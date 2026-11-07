import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionSnapshot } from '../../server/auth'
import { config } from '../../server/config'
import { HttpError } from '../../server/http'

test('joined session snapshots retain current membership and reject disabled or mismatched identities', () => {
  const member = {
    id: 'member-a',
    issuer: config.issuer,
    subject: 'subject-a',
    tenant_id: 'tenant-a',
    display_name: '合成成员',
    email: 'member@example.test',
    role: 'viewer',
    enabled: true
  }
  const value = {
    token_hash: 'hash',
    member_id: member.id,
    payload: 'encrypted',
    csrf_token: 'csrf',
    expires_at: '2026-11-08T00:00:00Z',
    member
  }
  assert.deepEqual(sessionSnapshot(value).member, member)
  for (const invalid of [
    null,
    { ...member, enabled: false },
    { ...member, issuer: 'https://other.invalid' }
  ])
    assert.throws(
      () => sessionSnapshot({ ...value, member: invalid }),
      (error: unknown) => error instanceof HttpError && error.status === 403
    )
  for (const invalid of [
    { ...member, id: 'member-b' },
    { ...member, role: 'forged-admin' }
  ])
    assert.throws(
      () => sessionSnapshot({ ...value, member: invalid }),
      (error: unknown) => error instanceof HttpError && error.status === 503
    )
})
