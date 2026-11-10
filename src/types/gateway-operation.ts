import type { InterfaceErrorClass, InterfaceMethod } from './interface'
import type { CallRecord, CallStatus } from './observability'
import type { GatewayResponse } from './release'
import type { UpstreamEnvironment } from './upstream'

export type DispatchState = 'not_sent' | 'started' | 'legacy_unknown'
export type ReconciliationConclusion =
  'confirmed_executed' | 'confirmed_not_executed' | 'manually_resolved'

export interface CallReconciliation {
  id: string
  conclusion: ReconciliationConclusion
  evidence: string
  createdAt: string
  createdByName: string
}

export interface GatewayOperation {
  operationId: string
  requestId: string
  attemptNo: number
  status: CallStatus
  dispatchState: DispatchState
  retryAllowed: boolean
  retryBlockedReason: string | null
  applicationId: string
  applicationCode: string
  applicationName: string
  environment: UpstreamEnvironment
  interfaceId: string
  interfaceName: string
  versionNumber: number
  deploymentVersion: number
  method: InterfaceMethod
  pathTemplate: string
  startedAt: string
  finishedAt: string | null
  errorCode: string | null
  errorClass: InterfaceErrorClass | null
  detailsExpired: boolean
  resultAvailable: boolean
  reconciliation: CallReconciliation | null
}

export interface GatewayOperationList {
  records: GatewayOperation[]
  total: number
  current: number
  size: number
}

export interface GatewayOperationListQuery {
  current: number
  size: number
  applicationId?: string
  environment?: UpstreamEnvironment
  status?: CallStatus
  reconciliation?: 'pending' | 'closed'
  operationId?: string
}

export interface GatewayOperationDetail {
  operation: GatewayOperation
  attempts: CallRecord[]
}

export type GatewayOperationLookup =
  { operationId: string } | { requestId: string } | { idempotencyKey: string }

export interface GatewayOperationStatus {
  operation: GatewayOperation | null
  result?: GatewayResponse
}
