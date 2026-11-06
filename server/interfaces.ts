import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { uniq } from 'lodash-es'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type {
  InterfaceList,
  InterfaceOptions,
  InterfaceRecord,
  InterfaceStep,
  InterfaceTestResult
} from '../src/types/interface'
import { type Session, requireMutation } from './auth'
import { database } from './database/client'
import { body, HttpError } from './http'
import { uuid } from './applications'
import { controlFailure, revisionInput, text } from './control-plane'
import {
  interfaceInput,
  parseInterfaceSample,
  validateInterfaceDefinition
} from './interface-definition'
import { runInterface, type InterfaceStepTarget } from './interface-runner'
import {
  interfaceWriteTestOrigins,
  loadUpstreamCredential,
  upstreamPolicy
} from './upstream-runtime'

function failure(error: { code?: string; message?: string } | null): void {
  if (error?.message === 'BFF_INTERFACE_WRITE_PRODUCTION')
    throw new HttpError(403, '生产环境草稿只允许 GET 试运行')
  if (error?.code === '23505')
    throw new HttpError(409, '接口编码或同环境的方法与路径已存在，请更换后重试')
  const messages: Record<string, string> = {
    BFF_INTERFACE_IMMUTABLE: '接口所属应用、环境和编码创建后不可变更',
    BFF_INTERFACE_IDENTITY_IMMUTABLE: '接口所属应用、环境和编码创建后不可变更',
    BFF_INTERFACE_NOT_VALIDATED: '请先校验当前接口草稿，再发起试运行',
    BFF_INTERFACE_UPSTREAM_CHANGED: '上游配置版本已变化，请重新选择后校验',
    BFF_INTERFACE_UPSTREAM_INVALID: '上游服务归属或版本已变化，请重新选择后保存',
    BFF_INTERFACE_REFERENCED: '接口仍被其他记录引用，请处理关联后再删除'
  }
  if (error?.message && Object.hasOwn(messages, error.message))
    throw new HttpError(409, messages[error.message])
  controlFailure(error)
}
function nullableNumber(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid interface revision')
  return value
}
function nullableTime(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') throw new Error('Invalid interface timestamp')
  return value
}
export function interfaceDto(value: unknown): InterfaceRecord {
  if (!isObjectRecord(value) || !isObjectRecord(value.application))
    throw new Error('Invalid interface record')
  const app = value.application
  if (
    typeof app.id !== 'string' ||
    typeof app.code !== 'string' ||
    typeof app.name !== 'string' ||
    typeof app.enabled !== 'boolean' ||
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !['unvalidated', 'valid', 'invalid'].includes(String(value.validationStatus)) ||
    !['not_tested', 'passed', 'failed', 'stale'].includes(String(value.lastTestStatus)) ||
    !Array.isArray(value.validationIssues) ||
    value.validationIssues.length > 40 ||
    !value.validationIssues.every(
      (issue: unknown) => typeof issue === 'string' && issue.length <= 500
    )
  )
    throw new Error('Invalid interface record')
  const normalized = interfaceInput(value)
  const validationStatus = value.validationStatus
  const lastTestStatus = value.lastTestStatus
  if (
    validationStatus !== 'unvalidated' &&
    validationStatus !== 'valid' &&
    validationStatus !== 'invalid'
  )
    throw new Error('Invalid validation state')
  if (
    lastTestStatus !== 'not_tested' &&
    lastTestStatus !== 'passed' &&
    lastTestStatus !== 'failed' &&
    lastTestStatus !== 'stale'
  )
    throw new Error('Invalid test state')
  return {
    ...normalized,
    id: value.id,
    application: { id: app.id, code: app.code, name: app.name, enabled: app.enabled },
    version: revisionInput(value.version),
    validationStatus,
    validatedVersion: nullableNumber(value.validatedVersion),
    validationIssues: value.validationIssues,
    lastValidatedAt: nullableTime(value.lastValidatedAt),
    lastTestStatus,
    lastTestVersion: nullableNumber(value.lastTestVersion),
    lastTestAt: nullableTime(value.lastTestAt),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt
  }
}
async function target(
  session: Session,
  id: string,
  permission: string,
  timeoutMs = 30_000
): Promise<InterfaceRecord> {
  const result = await database
    .rpc('bff_interface_target', {
      p_actor: session.member.id,
      p_id: uuid(id),
      p_permission: permission
    })
    .abortSignal(AbortSignal.timeout(Math.max(1, timeoutMs)))
  failure(result.error)
  return interfaceDto(result.data)
}
export async function listInterfaces(session: Session, url: URL): Promise<InterfaceList> {
  const current = Number(url.searchParams.get('current') || 1),
    size = Number(url.searchParams.get('size') || 20)
  if (
    !Number.isSafeInteger(current) ||
    current < 1 ||
    current > 100000 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 100
  )
    throw new HttpError(400, '分页范围无效')
  const filters: Record<string, unknown> = {
    current,
    size,
    name: text(url.searchParams.get('name'), '查询条件', 100)
  }
  for (const key of ['applicationId', 'recordId'] as const)
    if (url.searchParams.get(key)) filters[key] = uuid(url.searchParams.get(key)!)
  const environment = url.searchParams.get('environment'),
    state = url.searchParams.get('validationStatus')
  if (environment) {
    if (!['development', 'staging', 'production'].includes(environment))
      throw new HttpError(400, '运行环境无效')
    filters.environment = environment
  }
  if (state) {
    if (!['unvalidated', 'valid', 'invalid'].includes(state))
      throw new HttpError(400, '校验状态无效')
    filters.validationStatus = state
  }
  const result = await database.rpc('bff_read_interfaces', {
    p_actor: session.member.id,
    p_filters: filters
  })
  failure(result.error)
  const data: unknown = result.data
  if (
    !isObjectRecord(data) ||
    !Array.isArray(data.records) ||
    typeof data.total !== 'number' ||
    !isObjectRecord(data.summary)
  )
    throw new Error('Invalid interface list')
  const summary = data.summary
  if (
    typeof summary.total !== 'number' ||
    typeof summary.valid !== 'number' ||
    typeof summary.unvalidated !== 'number' ||
    typeof summary.tested !== 'number'
  )
    throw new Error('Invalid interface summary')
  return {
    records: data.records.map(interfaceDto),
    total: data.total,
    current,
    size,
    summary: {
      total: summary.total,
      valid: summary.valid,
      unvalidated: summary.unvalidated,
      tested: summary.tested
    }
  }
}
export async function interfaceOptions(session: Session): Promise<InterfaceOptions> {
  const result = await database.rpc('bff_interface_options', { p_actor: session.member.id })
  failure(result.error)
  const data: unknown = result.data
  if (
    !isObjectRecord(data) ||
    !Array.isArray(data.applications) ||
    !Array.isArray(data.environments) ||
    !Array.isArray(data.upstreams)
  )
    throw new Error('Invalid interface options')
  return {
    applications: data.applications.map((value: unknown) => {
      if (
        !isObjectRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.code !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.enabled !== 'boolean'
      )
        throw new Error('Invalid application option')
      return { id: value.id, code: value.code, name: value.name, enabled: value.enabled }
    }),
    environments: data.environments.map((value: unknown) => {
      if (
        !isObjectRecord(value) ||
        typeof value.label !== 'string' ||
        (value.value !== 'development' && value.value !== 'staging' && value.value !== 'production')
      )
        throw new Error('Invalid environment option')
      return { value: value.value, label: value.label }
    }),
    upstreams: data.upstreams.map((value: unknown) => {
      if (
        !isObjectRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.applicationId !== 'string' ||
        typeof value.code !== 'string' ||
        typeof value.name !== 'string' ||
        (value.environment !== 'development' &&
          value.environment !== 'staging' &&
          value.environment !== 'production') ||
        (value.status !== 'draft' && value.status !== 'active' && value.status !== 'disabled') ||
        (value.authType !== 'none' &&
          value.authType !== 'bearer' &&
          value.authType !== 'api_key_header') ||
        typeof value.credentialConfigured !== 'boolean'
      )
        throw new Error('Invalid upstream option')
      return {
        id: value.id,
        applicationId: value.applicationId,
        environment: value.environment,
        code: value.code,
        name: value.name,
        status: value.status,
        authType: value.authType,
        credentialConfigured: value.credentialConfigured,
        configVersion: revisionInput(value.configVersion)
      }
    }),
    networkPolicyConfigured: upstreamPolicy.allowedOrigins.length > 0,
    writeTestsConfigured: interfaceWriteTestOrigins.length > 0
  }
}
export async function saveInterface(
  req: IncomingMessage,
  session: Session,
  id?: string
): Promise<InterfaceRecord> {
  requireMutation(req, session)
  const input = await body(req, 65536),
    definition = interfaceInput(input)
  const result = await database.rpc('bff_write_interface', {
    p_actor: session.member.id,
    p_operation: id ? 'update' : 'create',
    p_id: id ? uuid(id) : randomUUID(),
    p_version: id ? revisionInput(input.version) : null,
    p_definition: definition
  })
  failure(result.error)
  return interfaceDto(result.data)
}
export async function deleteInterface(
  req: IncomingMessage,
  session: Session,
  id: string
): Promise<{ saved: true }> {
  requireMutation(req, session)
  const input = await body(req)
  const result = await database.rpc('bff_write_interface', {
    p_actor: session.member.id,
    p_operation: 'delete',
    p_id: uuid(id),
    p_version: revisionInput(input.version),
    p_definition: {}
  })
  failure(result.error)
  return { saved: true }
}
export async function interfaceReferences(session: Session, id: string): Promise<unknown> {
  const result = await database.rpc('bff_interface_references', {
    p_actor: session.member.id,
    p_id: uuid(id)
  })
  failure(result.error)
  return result.data
}
async function definitionIssues(session: Session, record: InterfaceRecord): Promise<string[]> {
  const issues = validateInterfaceDefinition(record)
  const result = await database
    .from('bff_upstream_services')
    .select('id,config_version,environment')
    .eq('tenant_id', session.member.tenant_id)
    .eq('application_id', record.applicationId)
    .is('deleted_at', null)
    .in('id', uniq(record.definition.steps.map((step) => step.upstreamId)))
  failure(result.error)
  for (const step of record.definition.steps) {
    const current = result.data?.find((value) => value.id === step.upstreamId)
    if (
      !current ||
      current.config_version !== step.configVersion ||
      current.environment !== record.environment
    )
      issues.push(`步骤「${step.name}」的上游归属或配置版本已变化，请重新选择`)
  }
  return uniq(issues).slice(0, 40)
}
export async function validateInterface(
  req: IncomingMessage,
  session: Session,
  id: string
): Promise<InterfaceRecord> {
  requireMutation(req, session)
  const input = await body(req),
    version = revisionInput(input.version)
  const record = await target(session, id, 'BffInterface:Validate')
  if (record.version !== version) throw new HttpError(409, '接口草稿已更新，请刷新后重新校验')
  const issues = await definitionIssues(session, record)
  const result = await database.rpc('bff_record_interface_validation', {
    p_actor: session.member.id,
    p_id: uuid(id),
    p_version: version,
    p_issues: issues
  })
  failure(result.error)
  return interfaceDto(result.data)
}
interface ExecutionSnapshot {
  id: string
  configVersion: number
  credentialVersion: number
}
async function stepTarget(
  session: Session,
  record: InterfaceRecord,
  step: InterfaceStep,
  remainingMs: number,
  snapshots: Map<string, ExecutionSnapshot>
): Promise<InterfaceStepTarget> {
  const started = Date.now()
  const fresh = await target(session, record.id, 'BffInterface:Test', remainingMs)
  if (fresh.version !== record.version)
    throw new HttpError(409, '接口草稿在试运行期间发生变化，请重新校验和测试')
  if (!fresh.application.enabled) throw new HttpError(409, '所属应用已停用，不能试运行')
  if (step.method !== 'GET') {
    if (record.environment === 'production')
      throw new HttpError(403, '生产环境草稿只允许 GET 试运行')
    const authorized = await target(
      session,
      record.id,
      'BffInterface:TestWrite',
      Math.max(1, remainingMs - (Date.now() - started))
    )
    if (authorized.version !== record.version)
      throw new HttpError(409, '接口草稿已变化，请重新校验')
  }
  const result = await database
    .from('bff_upstream_services')
    .select('id,base_url,status,config_version,credential_version,auth_type,header_name,timeout_ms')
    .eq('id', step.upstreamId)
    .eq('tenant_id', session.member.tenant_id)
    .eq('application_id', record.applicationId)
    .eq('environment', record.environment)
    .is('deleted_at', null)
    .abortSignal(AbortSignal.timeout(Math.max(1, remainingMs - (Date.now() - started))))
    .maybeSingle()
  failure(result.error)
  const service: unknown = result.data
  if (!isObjectRecord(service) || service.status !== 'active')
    throw new HttpError(409, '上游服务尚未启用，请先完成连接配置')
  if (
    typeof service.id !== 'string' ||
    typeof service.base_url !== 'string' ||
    typeof service.config_version !== 'number' ||
    typeof service.credential_version !== 'number' ||
    typeof service.timeout_ms !== 'number' ||
    typeof service.header_name !== 'string' ||
    (service.auth_type !== 'none' &&
      service.auth_type !== 'bearer' &&
      service.auth_type !== 'api_key_header')
  )
    throw new Error('Invalid upstream execution target')
  if (service.config_version !== step.configVersion)
    throw new HttpError(409, '上游配置版本已变化，请重新选择后校验')
  const observed = snapshots.get(service.id)
  if (
    observed &&
    (observed.configVersion !== service.config_version ||
      observed.credentialVersion !== service.credential_version)
  )
    throw new HttpError(409, '上游凭据在试运行期间发生变化，请重新发起测试')
  if (!upstreamPolicy.allowedOrigins.includes(new URL(service.base_url).origin))
    throw new HttpError(409, '上游源站未列入网络允许范围')
  if (
    step.method !== 'GET' &&
    !interfaceWriteTestOrigins.includes(new URL(service.base_url).origin)
  )
    throw new HttpError(403, '该上游未列入受控写操作测试源站，未发送请求')
  const credential = await loadUpstreamCredential({
    tenantId: session.member.tenant_id,
    applicationId: record.applicationId,
    serviceId: service.id,
    version: service.credential_version,
    authType: service.auth_type,
    headerName: service.header_name,
    timeoutMs: Math.max(1, remainingMs - (Date.now() - started))
  })
  snapshots.set(service.id, {
    id: service.id,
    configVersion: service.config_version,
    credentialVersion: service.credential_version
  })
  return { baseUrl: service.base_url, timeoutMs: service.timeout_ms, credential }
}
const activeTests = new Set<string>()
export async function testInterface(
  req: IncomingMessage,
  session: Session,
  id: string
): Promise<InterfaceTestResult> {
  requireMutation(req, session)
  const input = await body(req, 65536),
    version = revisionInput(input.version)
  const record = await target(session, id, 'BffInterface:Test')
  if (record.version !== version) throw new HttpError(409, '接口草稿已更新，请刷新后重试')
  if (record.validationStatus !== 'valid' || record.validatedVersion !== version)
    throw new HttpError(409, '请先校验当前草稿，再发起试运行')
  if (record.definition.steps.some((step) => step.method !== 'GET')) {
    if (record.environment === 'production')
      throw new HttpError(403, '生产环境草稿只允许 GET 试运行')
    if (!interfaceWriteTestOrigins.length)
      throw new HttpError(403, '写操作试运行尚未配置受控测试源站，请联系管理员')
    const authorized = await target(session, record.id, 'BffInterface:TestWrite')
    if (authorized.version !== record.version)
      throw new HttpError(409, '接口草稿已变化，请重新校验')
  }
  const sample = parseInterfaceSample(record.definition.inputs, input.input)
  if (
    activeTests.has(record.id) ||
    activeTests.size >= 4 ||
    (record.lastTestAt && Date.now() - Date.parse(record.lastTestAt) < 5000)
  )
    throw new HttpError(429, '试运行过于频繁，请稍后重试')
  activeTests.add(record.id)
  try {
    const snapshots = new Map<string, ExecutionSnapshot>()
    const result = await runInterface(record, sample, (step, budget) =>
      stepTarget(session, record, step, budget, snapshots)
    )
    const saved = await database.rpc('bff_record_interface_test', {
      p_actor: session.member.id,
      p_id: record.id,
      p_version: version,
      p_passed: result.passed,
      p_upstream_versions: [...snapshots.values()]
    })
    failure(saved.error)
    if (!isObjectRecord(saved.data) || typeof saved.data.stale !== 'boolean')
      throw new Error('Invalid test recorder response')
    if (saved.data.stale) {
      result.stale = true
      result.passed = false
      result.output = {}
      result.message = '接口或上游配置已变化，本次结果未应用，请重新校验与试运行'
    }
    return result
  } finally {
    activeTests.delete(record.id)
  }
}
