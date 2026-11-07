import type { IncomingMessage } from 'node:http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type {
  AlertEvaluation,
  AlertInstance,
  AlertList,
  AlertOptions,
  AlertRule,
  AlertRuleList,
  AlertRuleWriteInput,
  CallList,
  CallOptions,
  CallRecord,
  CallStepSummary
} from '../src/types/observability'
import { uuid } from './applications'
import { requireMutation, type Session } from './auth'
import { text, revisionInput } from './control-plane'
import { database } from './database/client'
import { body, HttpError } from './http'

const environments = ['development', 'staging', 'production'] as const
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
const callStatuses = ['running', 'succeeded', 'failed', 'unknown'] as const
const errorClasses = [
  'timeout',
  'upstream',
  'unknown',
  'authorization',
  'validation',
  'rate_limited'
] as const
const callErrorFilters = [...errorClasses, 'unclassified'] as const
const metrics = ['failure_count', 'failure_rate', 'timeout_count', 'unknown_count'] as const
const severities = ['warning', 'critical'] as const
const states = ['open', 'acknowledged', 'recovered', 'closed'] as const

function rpcFailure(error: { code?: string; message?: string } | null): void {
  if (!error) return
  const messages: Record<string, [number, string]> = {
    BFF_FORBIDDEN: [403, '当前账号没有此操作权限'],
    BFF_NOT_FOUND: [404, '记录不存在，或已不在当前工作空间'],
    BFF_CONFLICT: [409, '记录已变化，请刷新后重试'],
    BFF_INVALID_RANGE: [400, '查询时间范围不能超过 30 天'],
    BFF_INVALID_RULE: [400, '告警规则内容无效，请检查后重试'],
    BFF_INVALID_STATE: [409, '当前告警状态无法执行此操作，请刷新后重试'],
    BFF_ALERT_STATE: [409, '当前告警状态无法执行此操作，请刷新后重试'],
    BFF_ALERT_ARCHIVED: [409, '规则已归档，请刷新后重试']
  }
  const known = error.message ? messages[error.message] : undefined
  if (known) throw new HttpError(known[0], known[1], error.message)
  if (error.message?.startsWith('BFF_INVALID_')) throw new HttpError(400, '提交内容格式有误')
  throw new Error('可观测性数据库操作失败', { cause: error })
}
function record(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new Error('Invalid observability response')
  return value
}
function string(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || value.length > 500) throw new Error('Invalid observability text')
  return value
}
function number(
  value: unknown,
  min: number,
  max: number,
  nullable = false,
  integer = true
): number | null {
  if (nullable && value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error('Invalid observability number')
  return value
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid observability boolean')
  return value
}
function choice<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value))
    throw new Error('Invalid observability choice')
  return value as T[number]
}
function optionalChoice<const T extends readonly string[]>(
  value: unknown,
  values: T
): T[number] | null {
  return value === null || value === undefined ? null : choice(value, values)
}
function timestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error('Invalid observability timestamp')
  return value
}
function safeCode(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 80 && /^[A-Z][A-Z0-9_]*$/.test(value)
    ? value
    : null
}
function steps(value: unknown): CallStepSummary[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Invalid call steps')
  return value.map((item) => {
    const row = record(item)
    return {
      key: string(row.key)!,
      status: choice(row.status, ['passed', 'failed', 'skipped'] as const),
      code: safeCode(row.code),
      errorClass: optionalChoice(row.errorClass, errorClasses),
      statusCode: number(row.statusCode, 100, 599, true),
      durationMs: number(row.durationMs, 0, 60_000)!
    }
  })
}
export function callDto(value: unknown): CallRecord {
  const row = record(value)
  return {
    requestId: uuid(string(row.requestId)!),
    applicationId: uuid(string(row.applicationId)!),
    applicationName: string(row.applicationName)!,
    environment: choice(row.environment, environments),
    interfaceId: uuid(string(row.interfaceId)!),
    interfaceName: string(row.interfaceName)!,
    versionNumber: number(row.versionNumber, 1, 2_147_483_647)!,
    method: choice(row.method, methods),
    pathTemplate: string(row.pathTemplate)!,
    startedAt: timestamp(row.startedAt)!,
    finishedAt: timestamp(row.finishedAt, true),
    durationMs: number(row.durationMs, 0, 60_000, true),
    status: choice(row.status, callStatuses),
    httpStatus: number(row.httpStatus, 100, 599, true),
    errorCode: safeCode(row.errorCode),
    errorClass: optionalChoice(row.errorClass, errorClasses),
    steps: steps(row.steps)
  }
}
function ruleDto(value: unknown): AlertRule {
  const row = record(value)
  const metric = choice(row.metric, metrics)
  const windowMinutes = number(row.windowMinutes, 5, 60)!
  const threshold = number(
    row.threshold,
    metric === 'failure_rate' ? 0.1 : 1,
    metric === 'failure_rate' ? 100 : 999_999,
    false,
    metric !== 'failure_rate'
  )!
  if (![5, 15, 60].includes(windowMinutes)) throw new Error('Invalid alert window')
  return {
    id: uuid(string(row.id)!),
    applicationId: uuid(string(row.applicationId)!),
    applicationName: string(row.applicationName)!,
    environment: choice(row.environment, environments),
    interfaceId: row.interfaceId === null ? null : uuid(string(row.interfaceId)!),
    interfaceName: string(row.interfaceName, true),
    name: string(row.name)!,
    metric,
    windowMinutes,
    threshold,
    minCalls: number(row.minCalls, 1, 1_000_000)!,
    severity: choice(row.severity, severities),
    enabled: boolean(row.enabled),
    quietMinutes: number(row.quietMinutes, 0, 1440)!,
    version: number(row.version, 1, 2_147_483_647)!,
    archivedAt: timestamp(row.archivedAt, true),
    lastEvaluatedAt: timestamp(row.lastEvaluatedAt, true),
    createdAt: timestamp(row.createdAt)!,
    updatedAt: timestamp(row.updatedAt)!
  }
}
function instanceDto(value: unknown): AlertInstance {
  const row = record(value)
  return {
    id: uuid(string(row.id)!),
    ruleId: uuid(string(row.ruleId)!),
    ruleName: string(row.ruleName)!,
    applicationId: uuid(string(row.applicationId)!),
    applicationName: string(row.applicationName)!,
    environment: choice(row.environment, environments),
    interfaceId: row.interfaceId === null ? null : uuid(string(row.interfaceId)!),
    interfaceName: string(row.interfaceName, true),
    metric: choice(row.metric, metrics),
    severity: choice(row.severity, severities),
    state: choice(row.state, states),
    observedValue: number(row.observedValue, 0, 99_999_999.99, false, false)!,
    knownCalls: number(row.knownCalls, 0, 2_147_483_647)!,
    failedCalls: number(row.failedCalls, 0, 2_147_483_647)!,
    unknownCalls: number(row.unknownCalls, 0, 2_147_483_647)!,
    windowStartedAt: timestamp(row.windowStartedAt)!,
    windowEndedAt: timestamp(row.windowEndedAt)!,
    openedAt: timestamp(row.openedAt)!,
    acknowledgedAt: timestamp(row.acknowledgedAt, true),
    acknowledgedByName: string(row.acknowledgedByName, true),
    recoveredAt: timestamp(row.recoveredAt, true),
    closedAt: timestamp(row.closedAt, true),
    closedReason: string(row.closedReason, true),
    version: number(row.version, 1, 2_147_483_647)!,
    lastObservedAt: timestamp(row.lastObservedAt)!
  }
}
function page(url: URL): { current: number; size: number } {
  const current = Number(url.searchParams.get('current') || '1')
  const size = Number(url.searchParams.get('size') || '20')
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    current > 100000 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 100
  )
    throw new HttpError(400, '分页范围无效')
  return { current, size }
}
function queryChoice<const T extends readonly string[]>(
  url: URL,
  key: string,
  values: T
): T[number] | undefined {
  const value = url.searchParams.get(key)
  if (!value) return undefined
  if (!values.includes(value)) throw new HttpError(400, `${key} 查询条件无效`)
  return value as T[number]
}
function queryId(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)
  return value ? uuid(value) : undefined
}
function range(url: URL): { from: string; to: string } {
  const from = url.searchParams.get('from') || new Date(Date.now() - 86_400_000).toISOString()
  const to = url.searchParams.get('to') || new Date().toISOString()
  const start = Date.parse(from),
    end = Date.parse(to)
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(to) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 30 * 86_400_000 ||
    end > Date.now() + 60_000
  )
    throw new HttpError(400, '查询时间需为有效的 ISO 时间，且范围不超过 30 天')
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
}
function listResult<T>(
  value: unknown,
  map: (row: unknown) => T,
  current: number,
  size: number,
  keys: readonly string[]
): { records: T[]; total: number; current: number; size: number; summary: Record<string, number> } {
  const data = record(value)
  if (!Array.isArray(data.records) || data.records.length > size || !isObjectRecord(data.summary))
    throw new Error('Invalid observability list')
  const total = number(data.total, 0, Number.MAX_SAFE_INTEGER)!
  const summary: Record<string, number> = {}
  for (const key of keys) summary[key] = number(data.summary[key], 0, Number.MAX_SAFE_INTEGER)!
  return { records: data.records.map(map), total, current, size, summary }
}
export async function listCalls(session: Session, url: URL): Promise<CallList> {
  const { current, size } = page(url)
  const filters = {
    current,
    size,
    ...range(url),
    requestId: queryId(url, 'requestId'),
    applicationId: queryId(url, 'applicationId'),
    interfaceId: queryId(url, 'interfaceId'),
    environment: queryChoice(url, 'environment', environments),
    status: queryChoice(url, 'status', callStatuses),
    method: queryChoice(url, 'method', methods),
    errorClass: queryChoice(url, 'errorClass', callErrorFilters)
  }
  const result = await database.rpc(
    'bff_read_calls',
    { p_actor: session.member.id, p_filters: filters },
    { get: true }
  )
  rpcFailure(result.error)
  const data = listResult(result.data, callDto, current, size, [
    'total',
    'running',
    'succeeded',
    'failed',
    'unknown',
    'timeout'
  ])
  return { ...data, summary: data.summary as CallList['summary'] }
}
export async function callDetail(session: Session, requestId: string): Promise<CallRecord> {
  const result = await database.rpc(
    'bff_call_detail',
    { p_actor: session.member.id, p_request_id: uuid(requestId) },
    { get: true }
  )
  rpcFailure(result.error)
  return callDto(result.data)
}
export async function callOptions(session: Session): Promise<CallOptions> {
  const result = await database.rpc(
    'bff_call_options',
    { p_actor: session.member.id },
    { get: true }
  )
  rpcFailure(result.error)
  const value = record(result.data)
  return {
    ...scopeOptionsDto(value),
    statuses: optionArray(value.statuses, callStatuses) as CallOptions['statuses'],
    errorClasses: optionArray(value.errorClasses, callErrorFilters) as CallOptions['errorClasses']
  }
}
function optionArray(
  value: unknown,
  values?: readonly string[]
): Array<{ value: string; label: string }> {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Invalid observability options')
  return value.map((item) => {
    const row = record(item)
    const option = { value: string(row.value)!, label: string(row.label)! }
    if (values && !values.includes(option.value)) throw new Error('Invalid observability option')
    return option
  })
}
function scopeOptionsDto(
  value: unknown
): Pick<CallOptions, 'applications' | 'interfaces' | 'environments'> {
  const data = record(value)
  if (
    !Array.isArray(data.applications) ||
    !Array.isArray(data.interfaces) ||
    data.applications.length > 1000 ||
    data.interfaces.length > 5000
  )
    throw new Error('Invalid observability options')
  const applications = data.applications.map((item) => {
    const row = record(item)
    return {
      id: uuid(string(row.id)!),
      code: string(row.code)!,
      name: string(row.name)!,
      enabled: boolean(row.enabled)
    }
  })
  const interfaces = data.interfaces.map((item) => {
    const row = record(item)
    return {
      id: uuid(string(row.id)!),
      applicationId: uuid(string(row.applicationId)!),
      environment: choice(row.environment, environments),
      code: string(row.code)!,
      name: string(row.name)!
    }
  })
  return {
    applications,
    interfaces,
    environments: optionArray(data.environments, environments) as CallOptions['environments']
  }
}
export async function alertOptions(session: Session): Promise<AlertOptions> {
  const result = await database.rpc(
    'bff_alert_options',
    { p_actor: session.member.id },
    { get: true }
  )
  rpcFailure(result.error)
  const value = record(result.data)
  return {
    ...scopeOptionsDto(value),
    metrics: optionArray(value.metrics, metrics) as AlertOptions['metrics'],
    severities: optionArray(value.severities, severities) as AlertOptions['severities'],
    statuses: optionArray(value.statuses, states) as AlertOptions['statuses'],
    errorClasses: optionArray(value.errorClasses, errorClasses) as AlertOptions['errorClasses']
  }
}
export async function listAlertRules(session: Session, url: URL): Promise<AlertRuleList> {
  const { current, size } = page(url)
  const filters = {
    current,
    size,
    applicationId: queryId(url, 'applicationId'),
    interfaceId: queryId(url, 'interfaceId'),
    environment: queryChoice(url, 'environment', environments),
    metric: queryChoice(url, 'metric', metrics),
    severity: queryChoice(url, 'severity', severities),
    name: text(url.searchParams.get('name'), '规则名称', 100),
    enabled: queryBoolean(url, 'enabled'),
    archived: queryBoolean(url, 'archived') ?? false
  }
  const result = await database.rpc(
    'bff_read_alert_rules',
    { p_actor: session.member.id, p_filters: filters },
    { get: true }
  )
  rpcFailure(result.error)
  const data = listResult(result.data, ruleDto, current, size, [
    'total',
    'enabled',
    'disabled',
    'archived'
  ])
  return { ...data, summary: data.summary as AlertRuleList['summary'] }
}
function queryBoolean(url: URL, key: string): boolean | undefined {
  const value = url.searchParams.get(key)
  if (value === null || value === '') return undefined
  if (value !== 'true' && value !== 'false') throw new HttpError(400, `${key} 查询条件无效`)
  return value === 'true'
}
export async function listAlerts(session: Session, url: URL): Promise<AlertList> {
  const { current, size } = page(url)
  const bounds = url.searchParams.has('from') || url.searchParams.has('to') ? range(url) : {}
  const filters = {
    current,
    size,
    ...bounds,
    applicationId: queryId(url, 'applicationId'),
    interfaceId: queryId(url, 'interfaceId'),
    ruleId: queryId(url, 'ruleId'),
    environment: queryChoice(url, 'environment', environments),
    state: queryChoice(url, 'state', states),
    severity: queryChoice(url, 'severity', severities)
  }
  const result = await database.rpc(
    'bff_read_alert_instances',
    { p_actor: session.member.id, p_filters: filters },
    { get: true }
  )
  rpcFailure(result.error)
  const data = listResult(result.data, instanceDto, current, size, [
    'total',
    'open',
    'acknowledged',
    'recovered',
    'closed'
  ])
  return { ...data, summary: data.summary as AlertList['summary'] }
}
export async function alertDetail(session: Session, id: string): Promise<AlertInstance> {
  const result = await database.rpc(
    'bff_alert_detail',
    { p_actor: session.member.id, p_instance: uuid(id) },
    { get: true }
  )
  rpcFailure(result.error)
  return instanceDto(result.data)
}
function ruleInput(value: Record<string, unknown>): AlertRuleWriteInput {
  const metric = value.metric
  if (typeof value.applicationId !== 'string') throw new HttpError(400, '请选择所属应用')
  if (
    value.interfaceId !== null &&
    value.interfaceId !== undefined &&
    typeof value.interfaceId !== 'string'
  )
    throw new HttpError(400, '接口标识格式有误')
  const windowMinutes = numberInput(value.windowMinutes, '统计窗口', 1, 1440)
  if (![5, 15, 60].includes(windowMinutes))
    throw new HttpError(400, '统计窗口只支持 5、15 或 60 分钟')
  const threshold = numberInput(
    value.threshold,
    '阈值',
    metric === 'failure_rate' ? 0.1 : 1,
    metric === 'failure_rate' ? 100 : 1000000
  )
  if (metric !== 'failure_rate' && !Number.isSafeInteger(threshold))
    throw new HttpError(400, '次数阈值需为整数')
  return {
    applicationId: uuid(value.applicationId),
    environment: inputChoice(value.environment, environments),
    interfaceId: value.interfaceId ? uuid(value.interfaceId) : null,
    name: text(value.name, '规则名称', 100, true),
    metric: inputChoice(metric, metrics),
    windowMinutes,
    threshold,
    minCalls: numberInput(value.minCalls, '最少调用量', 1, 1000000, true),
    severity: inputChoice(value.severity, severities),
    enabled: inputBoolean(value.enabled),
    quietMinutes: numberInput(value.quietMinutes, '静默时间', 0, 1440, true)
  }
}
function inputChoice<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value))
    throw new HttpError(400, '提交的选项无效')
  return value as T[number]
}
function inputBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, '状态格式有误')
  return value
}
function numberInput(
  value: unknown,
  label: string,
  min: number,
  max: number,
  integer = true
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new HttpError(400, `${label}需在有效范围内`)
  return value
}
export async function writeAlertRule(
  req: IncomingMessage,
  session: Session,
  operation: 'create' | 'update' | 'enable' | 'disable' | 'archive',
  id?: string
): Promise<AlertRule> {
  requireMutation(req, session)
  const input = await body(req)
  const payload = operation === 'create' || operation === 'update' ? ruleInput(input) : {}
  const result = await database.rpc('bff_write_alert_rule', {
    p_actor: session.member.id,
    p_operation: operation,
    p_rule: id ? uuid(id) : null,
    p_version: operation === 'create' ? null : revisionInput(input.version),
    p_payload: payload
  })
  rpcFailure(result.error)
  return ruleDto(result.data)
}
export async function changeAlertRuleStatus(
  req: IncomingMessage,
  session: Session,
  id: string
): Promise<AlertRule> {
  requireMutation(req, session)
  const input = await body(req)
  return writeAlertRuleWithInput(
    session,
    inputBoolean(input.enabled) ? 'enable' : 'disable',
    id,
    revisionInput(input.version)
  )
}
async function writeAlertRuleWithInput(
  session: Session,
  operation: 'enable' | 'disable',
  id: string,
  version: number
): Promise<AlertRule> {
  const result = await database.rpc('bff_write_alert_rule', {
    p_actor: session.member.id,
    p_operation: operation,
    p_rule: uuid(id),
    p_version: version,
    p_payload: {}
  })
  rpcFailure(result.error)
  return ruleDto(result.data)
}
function evaluationDto(value: unknown): AlertEvaluation {
  const data = record(value)
  return {
    evaluated: number(data.evaluated, 0, 2_147_483_647)!,
    opened: number(data.opened, 0, 2_147_483_647)!,
    updated: number(data.updated, 0, 2_147_483_647)!,
    recovered: number(data.recovered, 0, 2_147_483_647)!,
    closed: number(data.closed, 0, 2_147_483_647)!,
    expired: number(data.expired, 0, 2_147_483_647)!,
    clearedReplay: number(data.clearedReplay, 0, 2_147_483_647)!,
    ...(data.instanceId === undefined
      ? {}
      : { instanceId: data.instanceId === null ? null : uuid(string(data.instanceId)!) })
  }
}
export async function evaluateAlertRule(
  req: IncomingMessage,
  session: Session,
  id: string
): Promise<AlertEvaluation> {
  requireMutation(req, session)
  await body(req)
  const result = await database.rpc('bff_evaluate_alert_rule', {
    p_actor: session.member.id,
    p_rule: uuid(id)
  })
  rpcFailure(result.error)
  return evaluationDto(result.data)
}
export async function acknowledgeAlert(
  req: IncomingMessage,
  session: Session,
  id: string
): Promise<AlertInstance> {
  requireMutation(req, session)
  const input = await body(req)
  const result = await database.rpc('bff_acknowledge_alert', {
    p_actor: session.member.id,
    p_instance: uuid(id),
    p_version: revisionInput(input.version)
  })
  rpcFailure(result.error)
  return instanceDto(result.data)
}
