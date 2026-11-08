import type {
  InterfaceDefinition,
  InterfaceMethod,
  InterfacePageResult,
  InterfaceScalar,
  InterfaceWriteInput
} from './interface'
import type { UpstreamApplication, UpstreamEnvironment } from './upstream'

export interface ReleaseVersion extends InterfaceWriteInput {
  id: string
  interfaceId: string
  number: number
  draftVersion: number
  checksum: string
  notes: string
  createdAt: string
  createdByName: string
}
export interface ReleaseDeployment {
  version: number
  enabled: boolean
  activeVersionId: string
  activeVersionNumber: number
  method: InterfaceMethod
  path: string
  updatedAt: string
  updatedByName: string
}
export interface ReleaseRecord {
  interfaceId: string
  applicationId: string
  application: UpstreamApplication
  environment: UpstreamEnvironment
  code: string
  name: string
  description: string
  draftVersion: number
  draftMethod: InterfaceMethod
  draftPath: string
  validationStatus: 'unvalidated' | 'valid' | 'invalid'
  lastTestStatus: 'not_tested' | 'passed' | 'failed' | 'stale'
  lastTestVersion: number | null
  versionCount: number
  deployment: ReleaseDeployment | null
}
export interface ReleaseEvent {
  id: string
  action: 'publish' | 'rollback' | 'enable' | 'disable'
  fromVersionNumber: number | null
  toVersionNumber: number
  deploymentVersion: number
  notes: string
  createdAt: string
  actorName: string
}
export interface ReleaseHistory {
  record: ReleaseRecord
  versions: ReleaseVersion[]
  events: ReleaseEvent[]
  versionsTotal: number
  eventsTotal: number
  versionPage: number
  eventPage: number
  size: number
}
export interface ReleaseListQuery {
  current: number
  size: number
  name?: string
  applicationId?: string
  environment?: UpstreamEnvironment
  status?: 'unpublished' | 'enabled' | 'disabled'
  recordId?: string
}
export interface ReleaseList {
  records: ReleaseRecord[]
  total: number
  current: number
  size: number
  summary: { total: number; enabled: number; disabled: number; unpublished: number }
}
export interface ReleaseCommand {
  interfaceId: string
  draftVersion?: number
  deploymentVersion: number
  targetVersionId?: string
  notes: string
}
export interface ReleaseStatusCommand {
  interfaceId: string
  deploymentVersion: number
  enabled: boolean
  notes: string
}
export interface ReleaseReadiness {
  ready: boolean
  checks: Array<{ key: string; label: string; passed: boolean; message: string }>
}
export interface ReleaseOptions {
  applications: UpstreamApplication[]
  environments: Array<{ label: string; value: UpstreamEnvironment }>
}
/** Server-owned immutable definition executed by the authenticated gateway. */
export interface PublishedExecution {
  interfaceId: string
  versionId: string
  versionNumber: number
  deploymentVersion: number
  applicationId: string
  environment: UpstreamEnvironment
  code: string
  name: string
  description: string
  method: InterfaceMethod
  path: string
  definition: InterfaceDefinition
}
export interface GatewayResponse {
  requestId: string
  version: number
  code?: 200
  msg?: string
  data: Record<string, InterfaceScalar> | InterfacePageResult
}
