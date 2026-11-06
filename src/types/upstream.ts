export type UpstreamEnvironment = 'development' | 'staging' | 'production'
export type UpstreamStatus = 'draft' | 'active' | 'disabled'
export type UpstreamAuthType = 'none' | 'bearer' | 'api_key_header'
export type UpstreamHealthStatus = 'unknown' | 'reachable' | 'failed' | 'stale'

export interface UpstreamApplication {
  id: string
  code: string
  name: string
  enabled: boolean
}

export interface UpstreamService {
  id: string
  applicationId: string
  application: UpstreamApplication
  code: string
  name: string
  description: string
  environment: UpstreamEnvironment
  status: UpstreamStatus
  baseUrl: string
  authType: UpstreamAuthType
  headerName: string
  timeoutMs: number
  version: number
  configVersion: number
  credentialConfigured: boolean
  credentialVersion: number
  healthStatus: UpstreamHealthStatus
  /** A newer configuration superseded this test; its probe result was not applied. */
  probeStale?: boolean
  lastCheckedAt: string | null
  lastStatusCode: number | null
  lastDurationMs: number | null
  lastHealthMessage: string
  createdAt: string
  updatedAt: string
}

export interface UpstreamSummary {
  total: number
  active: number
  draft: number
  disabled: number
  reachable: number
  failed: number
}

export interface UpstreamList {
  records: UpstreamService[]
  total: number
  current: number
  size: number
  summary: UpstreamSummary
}

export interface UpstreamListQuery {
  current: number
  size: number
  applicationId?: string
  name?: string
  environment?: UpstreamEnvironment
  status?: UpstreamStatus
  recordId?: string
}

export interface UpstreamOptions {
  applications: UpstreamApplication[]
  environments: Array<{ label: string; value: UpstreamEnvironment }>
  credentialManagementReady: boolean
  networkPolicyConfigured: boolean
}

export interface UpstreamDefinition {
  name: string
  description: string
  baseUrl: string
  authType: UpstreamAuthType
  headerName: string
  timeoutMs: number
}

export interface UpstreamCreateInput extends UpstreamDefinition {
  applicationId: string
  code: string
  environment: UpstreamEnvironment
  credential?: string
}

export interface UpstreamUpdateInput extends UpstreamDefinition {
  version: number
  credential?: string
}

export interface UpstreamCredentialInput {
  version: number
  action: 'rotate' | 'clear'
  credential?: string
}
