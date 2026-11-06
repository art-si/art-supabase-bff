export type MemberBaseRole = 'admin' | 'viewer'

export interface MemberRecord {
  id: string
  displayName: string
  email: string
  role: MemberBaseRole
  enabled: boolean
  version: number
  roleNames: string[]
  applicationCount: number
  sessionCount: number
  createdAt: string
  updatedAt: string
}

export interface MemberSnapshot {
  revision: number
  records: MemberRecord[]
}

export interface MemberAccessUpdate {
  operation: 'update'
  revision: number
  definition: Pick<MemberRecord, 'id' | 'version' | 'enabled' | 'role'>
}
