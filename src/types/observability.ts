import type { InterfaceErrorClass, InterfaceMethod } from './interface'
import type { UpstreamEnvironment } from './upstream'

export type CallStatus = 'running' | 'succeeded' | 'failed' | 'unknown'
export type CallErrorClassFilter = InterfaceErrorClass | 'unclassified'
export interface CallStepSummary {
  key: string
  status: 'passed' | 'failed' | 'skipped'
  code: string | null
  errorClass: InterfaceErrorClass | null
  statusCode: number | null
  durationMs: number
}
export interface CallRecord {
  requestId: string
  applicationId: string
  applicationName: string
  environment: UpstreamEnvironment
  interfaceId: string
  interfaceName: string
  versionNumber: number
  method: InterfaceMethod
  pathTemplate: string
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  status: CallStatus
  httpStatus: number | null
  errorCode: string | null
  errorClass: InterfaceErrorClass | null
  steps: CallStepSummary[]
}
export interface ObservabilityApplicationOption {
  id: string
  code: string
  name: string
  enabled: boolean
}
export interface ObservabilityInterfaceOption {
  id: string
  applicationId: string
  name: string
  code: string
  environment: UpstreamEnvironment
}
export interface CallOptions {
  applications: ObservabilityApplicationOption[]
  environments: Array<{ value: UpstreamEnvironment; label: string }>
  interfaces: ObservabilityInterfaceOption[]
  statuses: Array<{ value: CallStatus; label: string }>
  errorClasses: Array<{ value: CallErrorClassFilter; label: string }>
}
export interface CallListQuery {
  current: number
  size: number
  requestId?: string
  applicationId?: string
  environment?: UpstreamEnvironment
  interfaceId?: string
  status?: CallStatus
  method?: InterfaceMethod
  errorClass?: CallErrorClassFilter
  from?: string
  to?: string
}
export interface CallList {
  records: CallRecord[]
  total: number
  current: number
  size: number
  summary: {
    total: number
    running: number
    succeeded: number
    failed: number
    unknown: number
    timeout: number
  }
}

export type AlertMetric = 'failure_count' | 'failure_rate' | 'timeout_count' | 'unknown_count'
export type AlertSeverity = 'warning' | 'critical'
export type AlertState = 'open' | 'acknowledged' | 'recovered' | 'closed'
export interface AlertRuleWriteInput {
  applicationId: string
  environment: UpstreamEnvironment
  interfaceId: string | null
  name: string
  metric: AlertMetric
  windowMinutes: number
  threshold: number
  minCalls: number
  severity: AlertSeverity
  enabled: boolean
  quietMinutes: number
}
export interface AlertRule extends AlertRuleWriteInput {
  id: string
  applicationName: string
  interfaceName: string | null
  version: number
  archivedAt: string | null
  lastEvaluatedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface AlertRuleListQuery {
  current: number
  size: number
  applicationId?: string
  environment?: UpstreamEnvironment
  interfaceId?: string
  metric?: AlertMetric
  severity?: AlertSeverity
  enabled?: boolean
  archived?: boolean
  name?: string
}
export interface AlertRuleList {
  records: AlertRule[]
  total: number
  current: number
  size: number
  summary: { total: number; enabled: number; disabled: number; archived: number }
}
export interface AlertInstance {
  id: string
  ruleId: string
  ruleName: string
  applicationId: string
  applicationName: string
  environment: UpstreamEnvironment
  interfaceId: string | null
  interfaceName: string | null
  metric: AlertMetric
  severity: AlertSeverity
  state: AlertState
  observedValue: number
  knownCalls: number
  failedCalls: number
  unknownCalls: number
  windowStartedAt: string
  windowEndedAt: string
  openedAt: string
  acknowledgedAt: string | null
  acknowledgedByName: string | null
  recoveredAt: string | null
  closedAt: string | null
  closedReason: string | null
  version: number
  lastObservedAt: string
}
export interface AlertListQuery {
  current: number
  size: number
  applicationId?: string
  environment?: UpstreamEnvironment
  interfaceId?: string
  ruleId?: string
  state?: AlertState
  severity?: AlertSeverity
  from?: string
  to?: string
}
export interface AlertList {
  records: AlertInstance[]
  total: number
  current: number
  size: number
  summary: { total: number; open: number; acknowledged: number; recovered: number; closed: number }
}
export interface AlertOptions {
  applications: ObservabilityApplicationOption[]
  environments: Array<{ value: UpstreamEnvironment; label: string }>
  interfaces: ObservabilityInterfaceOption[]
  metrics: Array<{ value: AlertMetric; label: string }>
  severities: Array<{ value: AlertSeverity; label: string }>
  statuses: Array<{ value: AlertState; label: string }>
  errorClasses: Array<{ value: InterfaceErrorClass; label: string }>
}
export interface AlertEvaluation {
  evaluated: number
  opened: number
  updated: number
  recovered: number
  closed: number
  expired: number
  clearedReplay: number
  instanceId?: string | null
}
