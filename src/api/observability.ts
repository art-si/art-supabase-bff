import { call } from './bff'
import type {
  AlertEvaluation,
  AlertInstance,
  AlertList,
  AlertListQuery,
  AlertOptions,
  AlertRule,
  AlertRuleList,
  AlertRuleListQuery,
  AlertRuleWriteInput,
  CallList,
  CallListQuery,
  CallOptions,
  CallRecord
} from '../types/observability'

function listParams(query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== '') params.set(key, String(value))
  return params.toString()
}

export function fetchCalls(query: CallListQuery): Promise<CallList> {
  return call<CallList>(`/api/calls?${listParams({ ...query })}`)
}
export function fetchCallOptions(): Promise<CallOptions> {
  return call<CallOptions>('/api/calls/options')
}
export function fetchCallDetail(requestId: string): Promise<CallRecord> {
  return call<CallRecord>(`/api/calls/${encodeURIComponent(requestId)}`)
}
export function fetchAlertOptions(): Promise<AlertOptions> {
  return call<AlertOptions>('/api/alerts/options')
}
export function fetchAlertRules(query: AlertRuleListQuery): Promise<AlertRuleList> {
  return call<AlertRuleList>(`/api/alerts/rules?${listParams({ ...query })}`)
}
export function createAlertRule(input: AlertRuleWriteInput): Promise<AlertRule> {
  return call<AlertRule>('/api/alerts/rules', { method: 'POST', body: JSON.stringify(input) })
}
export function updateAlertRule(
  id: string,
  input: AlertRuleWriteInput & { version: number }
): Promise<AlertRule> {
  return call<AlertRule>(`/api/alerts/rules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  })
}
export function changeAlertRuleStatus(
  id: string,
  version: number,
  enabled: boolean
): Promise<AlertRule> {
  return call<AlertRule>(`/api/alerts/rules/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ version, enabled })
  })
}
export function archiveAlertRule(id: string, version: number): Promise<AlertRule> {
  return call<AlertRule>(`/api/alerts/rules/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    body: JSON.stringify({ version })
  })
}
export function evaluateAlertRule(id: string): Promise<AlertEvaluation> {
  return call<AlertEvaluation>(`/api/alerts/rules/${encodeURIComponent(id)}/evaluate`, {
    method: 'POST',
    body: '{}'
  })
}
export function fetchAlerts(query: AlertListQuery): Promise<AlertList> {
  return call<AlertList>(`/api/alerts?${listParams({ ...query })}`)
}
export function fetchAlertDetail(id: string): Promise<AlertInstance> {
  return call<AlertInstance>(`/api/alerts/${encodeURIComponent(id)}`)
}
export function acknowledgeAlert(id: string, version: number): Promise<AlertInstance> {
  return call<AlertInstance>(`/api/alerts/${encodeURIComponent(id)}/ack`, {
    method: 'POST',
    body: JSON.stringify({ version })
  })
}
