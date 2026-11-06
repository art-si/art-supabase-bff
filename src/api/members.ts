import { call } from '@bff/api/bff'
import type { MemberAccessUpdate, MemberSnapshot } from '@bff/types/member'

export function fetchMembers(): Promise<MemberSnapshot> {
  return call<MemberSnapshot>('/api/control/members')
}

export function updateMemberAccess(input: MemberAccessUpdate): Promise<MemberSnapshot> {
  return call<MemberSnapshot>('/api/control/members', {
    method: 'POST',
    body: JSON.stringify(input)
  })
}
