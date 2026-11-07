import type { IncomingMessage } from 'node:http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type { InterfaceWriteInput } from '../src/types/interface'
import type {
  ReleaseCommand,
  ReleaseDeployment,
  ReleaseEvent,
  ReleaseHistory,
  ReleaseList,
  ReleaseOptions,
  ReleaseReadiness,
  ReleaseRecord,
  ReleaseVersion
} from '../src/types/release'
import { type Session, requireMutation } from './auth'
import { database } from './database/client'
import { body, HttpError } from './http'
import { uuid } from './applications'
import { controlFailure, revisionInput, text } from './control-plane'
import {
  interfaceInput,
  interfaceMethod,
  interfacePath,
  validateInterfaceDefinition
} from './interface-definition'
import { loadPublishedTarget, type ReleaseUpstreamObservation } from './published-runtime'

type ReleaseOperation = 'publish' | 'rollback' | 'enable' | 'disable'
type ReadinessPurpose = Exclude<ReleaseOperation, 'disable'>
const permissions = {
  publish: 'BffRelease:Publish',
  rollback: 'BffRelease:Rollback',
  enable: 'BffRelease:ChangeStatus',
  disable: 'BffRelease:ChangeStatus'
} as const

function failure(error: { code?: string; message?: string } | null): void {
  if (error?.code === '23505')
    throw new HttpError(409, '该请求方法与路径已有生效接口，请处理冲突后重试')
  const messages: Record<string, string> = {
    BFF_RELEASE_NOT_TESTED: '请先验证当前接口草稿并完成成功测试',
    BFF_RELEASE_UPSTREAM_CHANGED: '上游配置或凭据已变化，请重新测试后再发布',
    BFF_RELEASE_APP_DISABLED: '请先启用所属应用',
    BFF_RELEASE_GET_WRITE_STEP: 'GET 入口只能包含 GET 上游步骤，请调整请求方法',
    BFF_RELEASE_TARGET_INVALID: '请选择其他有效的历史版本',
    BFF_RELEASE_UNPUBLISHED: '尚无可启用的发布版本'
  }
  if (error?.message && Object.hasOwn(messages, error.message))
    throw new HttpError(409, messages[error.message])
  controlFailure(error)
}
function object(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new Error('Invalid release response')
  return value
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid release text')
  return value
}
function count(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new Error('Invalid release revision')
  return value
}
function nullableRevision(value: unknown): number | null {
  return value === null ? null : count(value, 1)
}
function environment(value: unknown): ReleaseRecord['environment'] {
  if (value !== 'development' && value !== 'staging' && value !== 'production')
    throw new Error('Invalid release environment')
  return value
}
function validationState(value: unknown): ReleaseRecord['validationStatus'] {
  if (value !== 'valid' && value !== 'invalid' && value !== 'unvalidated')
    throw new Error('Invalid validation state')
  return value
}
function testState(value: unknown): ReleaseRecord['lastTestStatus'] {
  if (value !== 'not_tested' && value !== 'passed' && value !== 'failed' && value !== 'stale')
    throw new Error('Invalid test state')
  return value
}
function deploymentDto(value: unknown): ReleaseDeployment | null {
  if (value === null) return null
  const item = object(value)
  if (typeof item.enabled !== 'boolean') throw new Error('Invalid deployment state')
  return {
    version: count(item.version, 1),
    enabled: item.enabled,
    activeVersionId: uuid(string(item.activeVersionId)),
    activeVersionNumber: count(item.activeVersionNumber, 1),
    method: interfaceMethod(item.method),
    path: interfacePath(item.path),
    updatedAt: string(item.updatedAt),
    updatedByName: string(item.updatedByName)
  }
}
export function releaseRecordDto(value: unknown): ReleaseRecord {
  const item = object(value),
    app = object(item.application)
  if (typeof app.enabled !== 'boolean') throw new Error('Invalid application state')
  if (item.applicationId !== app.id) throw new Error('Inconsistent release application')
  return {
    interfaceId: uuid(string(item.interfaceId)),
    applicationId: uuid(string(item.applicationId)),
    application: {
      id: uuid(string(app.id)),
      code: string(app.code),
      name: string(app.name),
      enabled: app.enabled
    },
    environment: environment(item.environment),
    code: string(item.code),
    name: string(item.name),
    description: string(item.description),
    draftVersion: count(item.draftVersion, 1),
    draftMethod: interfaceMethod(item.draftMethod),
    draftPath: interfacePath(item.draftPath),
    validationStatus: validationState(item.validationStatus),
    lastTestStatus: testState(item.lastTestStatus),
    lastTestVersion: nullableRevision(item.lastTestVersion),
    versionCount: count(item.versionCount),
    deployment: deploymentDto(item.deployment)
  }
}
function versionDto(value: unknown): ReleaseVersion {
  const item = object(value),
    base = interfaceInput(item)
  const checksum = string(item.checksum)
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid snapshot checksum')
  return {
    ...base,
    id: uuid(string(item.id)),
    interfaceId: uuid(string(item.interfaceId)),
    number: count(item.number, 1),
    draftVersion: count(item.draftVersion, 1),
    checksum,
    notes: string(item.notes),
    createdAt: string(item.createdAt),
    createdByName: string(item.createdByName)
  }
}
function eventDto(value: unknown): ReleaseEvent {
  const item = object(value),
    action = item.action
  if (action !== 'publish' && action !== 'rollback' && action !== 'enable' && action !== 'disable')
    throw new Error('Invalid release event')
  return {
    id: uuid(string(item.id)),
    action,
    fromVersionNumber: nullableRevision(item.fromVersionNumber),
    toVersionNumber: count(item.toVersionNumber, 1),
    deploymentVersion: count(item.deploymentVersion, 1),
    notes: string(item.notes),
    createdAt: string(item.createdAt),
    actorName: string(item.actorName)
  }
}
export function releaseHistoryDto(value: unknown): ReleaseHistory {
  const item = object(value)
  if (!Array.isArray(item.versions) || !Array.isArray(item.events))
    throw new Error('Invalid release history')
  return {
    record: releaseRecordDto(item.record),
    versions: item.versions.map(versionDto),
    events: item.events.map(eventDto),
    versionsTotal: count(item.versionsTotal),
    eventsTotal: count(item.eventsTotal),
    versionPage: count(item.versionPage, 1),
    eventPage: count(item.eventPage, 1),
    size: count(item.size, 1)
  }
}
export function deploymentRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new HttpError(400, '缺少有效的发布状态版本，请刷新后重试')
  return value
}
export function releaseCommandInput(
  value: Record<string, unknown>,
  operation: ReleaseOperation
): Omit<ReleaseCommand, 'interfaceId'> {
  return {
    deploymentVersion: deploymentRevision(value.deploymentVersion),
    notes: text(value.notes, '变更说明', 1000, true),
    ...(operation === 'publish' ? { draftVersion: revisionInput(value.draftVersion) } : {}),
    ...(operation === 'rollback'
      ? { targetVersionId: uuid(String(value.targetVersionId)).toLowerCase() }
      : {})
  }
}
export function releaseDefinitionIssues(value: InterfaceWriteInput): string[] {
  const issues = validateInterfaceDefinition(value)
  if (value.method === 'GET' && value.definition.steps.some((step) => step.method !== 'GET'))
    issues.push('GET 入口只能包含 GET 上游步骤，请调整入口方法后重新测试')
  return issues
}
async function target(session: Session, id: string, permission: string): Promise<ReleaseRecord> {
  const result = await database.rpc('bff_release_target', {
    p_actor: session.member.id,
    p_interface: uuid(id),
    p_permission: permission
  })
  failure(result.error)
  return releaseRecordDto(result.data)
}
export async function listReleases(session: Session, url: URL): Promise<ReleaseList> {
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
  const env = url.searchParams.get('environment'),
    status = url.searchParams.get('status')
  if (env) {
    if (!['development', 'staging', 'production'].includes(env))
      throw new HttpError(400, '运行环境无效')
    filters.environment = env
  }
  if (status) {
    if (!['unpublished', 'enabled', 'disabled'].includes(status))
      throw new HttpError(400, '发布状态无效')
    filters.status = status
  }
  const result = await database.rpc('bff_read_releases', {
    p_actor: session.member.id,
    p_filters: filters
  })
  failure(result.error)
  const data = object(result.data),
    summary = object(data.summary)
  if (!Array.isArray(data.records)) throw new Error('Invalid release list')
  return {
    records: data.records.map(releaseRecordDto),
    current,
    size,
    total: count(data.total),
    summary: {
      total: count(summary.total),
      enabled: count(summary.enabled),
      disabled: count(summary.disabled),
      unpublished: count(summary.unpublished)
    }
  }
}
export async function releaseOptions(session: Session): Promise<ReleaseOptions> {
  const result = await database.rpc('bff_release_options', { p_actor: session.member.id })
  failure(result.error)
  const data = object(result.data)
  if (!Array.isArray(data.applications) || !Array.isArray(data.environments))
    throw new Error('Invalid release options')
  return {
    applications: data.applications.map((value: unknown) => {
      const app = object(value)
      if (typeof app.enabled !== 'boolean') throw new Error('Invalid application option')
      return {
        id: uuid(string(app.id)),
        code: string(app.code),
        name: string(app.name),
        enabled: app.enabled
      }
    }),
    environments: data.environments.map((value: unknown) => {
      const item = object(value)
      return { value: environment(item.value), label: string(item.label) }
    })
  }
}
export async function releaseHistory(
  session: Session,
  id: string,
  url: URL
): Promise<ReleaseHistory> {
  const versionPage = Number(url.searchParams.get('versionPage') || 1),
    eventPage = Number(url.searchParams.get('eventPage') || 1),
    size = Number(url.searchParams.get('size') || 20)
  if (
    !Number.isSafeInteger(versionPage) ||
    versionPage < 1 ||
    versionPage > 100000 ||
    !Number.isSafeInteger(eventPage) ||
    eventPage < 1 ||
    eventPage > 100000 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > 50
  )
    throw new HttpError(400, '历史记录分页范围无效')
  const result = await database.rpc('bff_release_history', {
    p_actor: session.member.id,
    p_interface: uuid(id),
    p_version_page: versionPage,
    p_event_page: eventPage,
    p_size: size
  })
  failure(result.error)
  return releaseHistoryDto(result.data)
}
interface PreparedRelease {
  record: ReleaseRecord
  snapshot: InterfaceWriteInput
  readiness: ReleaseReadiness
  observations: ReleaseUpstreamObservation[]
}
async function prepareRelease(
  session: Session,
  id: string,
  purpose: ReadinessPurpose,
  targetVersionId?: string
): Promise<PreparedRelease> {
  const record = await target(session, id, permissions[purpose])
  let snapshot: InterfaceWriteInput
  let lastTestUpstreams: unknown = []
  let validatedVersion: unknown = null
  if (purpose === 'publish') {
    const result = await database
      .from('bff_interfaces')
      .select(
        'application_id,environment,code,name,description,method,path,definition,version,validated_version,last_test_upstreams'
      )
      .eq('id', record.interfaceId)
      .eq('tenant_id', session.member.tenant_id)
      .eq('application_id', record.applicationId)
      .is('deleted_at', null)
      .maybeSingle()
    failure(result.error)
    const row = object(result.data)
    if (row.version !== record.draftVersion)
      throw new HttpError(409, '接口草稿已变化，请刷新后重新检查')
    snapshot = interfaceInput({
      applicationId: row.application_id,
      environment: row.environment,
      code: row.code,
      name: row.name,
      description: row.description,
      method: row.method,
      path: row.path,
      definition: row.definition
    })
    lastTestUpstreams = row.last_test_upstreams
    validatedVersion = row.validated_version
  } else {
    const result = await database.rpc('bff_release_snapshot', {
      p_actor: session.member.id,
      p_interface: record.interfaceId,
      p_version_id: targetVersionId ? uuid(targetVersionId) : null,
      p_permission: permissions[purpose]
    })
    failure(result.error)
    snapshot = interfaceInput(object(result.data))
  }
  const checks: ReleaseReadiness['checks'] = []
  const add = (key: string, label: string, passed: boolean, message: string): void => {
    checks.push({ key, label, passed, message })
  }
  const issues = releaseDefinitionIssues(snapshot)
  add(
    'definition',
    '定义完整性',
    !issues.length,
    issues.length ? issues[0] : '参数、路径与步骤顺序正确'
  )
  add(
    'application',
    '所属应用',
    record.application.enabled,
    record.application.enabled ? '应用已启用' : '请先启用所属应用'
  )
  if (purpose === 'publish') {
    const valid = record.validationStatus === 'valid' && validatedVersion === record.draftVersion
    const tested =
      record.lastTestStatus === 'passed' && record.lastTestVersion === record.draftVersion
    add('validation', '草稿验证', valid, valid ? '当前草稿已验证' : '请先验证当前接口草稿')
    add(
      'test',
      '草稿测试',
      tested,
      tested ? '当前草稿已完成成功测试' : '请在受控环境完成当前草稿的成功测试'
    )
  }
  if (purpose === 'rollback')
    add(
      'version',
      '目标历史版本',
      targetVersionId !== record.deployment?.activeVersionId,
      '请选择其他历史版本'
    )
  if (purpose === 'enable')
    add(
      'status',
      '当前发布状态',
      Boolean(record.deployment && !record.deployment.enabled),
      record.deployment?.enabled ? '接口已启用' : '存在可重新启用的发布版本'
    )
  const observed = new Map<string, ReleaseUpstreamObservation>()
  const started = Date.now()
  for (const step of snapshot.definition.steps) {
    if (issues.length || !record.application.enabled) {
      add(`upstream:${step.key}`, step.name, false, '请先完成应用与定义检查')
      continue
    }
    try {
      const loaded = await loadPublishedTarget(session.member, snapshot, step, {
        requireCurrentConfig: purpose === 'publish',
        remainingMs: Math.max(1, 30_000 - (Date.now() - started))
      })
      const previous = observed.get(loaded.observed.id)
      if (
        previous &&
        (previous.configVersion !== loaded.observed.configVersion ||
          previous.currentConfigVersion !== loaded.observed.currentConfigVersion ||
          previous.credentialVersion !== loaded.observed.credentialVersion)
      )
        throw new HttpError(409, '上游在检查期间发生变化，请重新检查')
      observed.set(loaded.observed.id, loaded.observed)
      add(`upstream:${step.key}`, step.name, true, '上游已启用，固定配置、当前凭据与网络策略可用')
    } catch (error) {
      add(
        `upstream:${step.key}`,
        step.name,
        false,
        error instanceof HttpError ? error.message : '上游检查暂未完成，请稍后重试'
      )
    }
  }
  if (purpose === 'publish') {
    const tested =
      Array.isArray(lastTestUpstreams) &&
      lastTestUpstreams.length === observed.size &&
      observed.size > 0 &&
      [...observed.values()].every((item) =>
        lastTestUpstreams.some(
          (value: unknown) =>
            isObjectRecord(value) &&
            value.id === item.id &&
            value.configVersion === item.configVersion &&
            value.credentialVersion === item.credentialVersion
        )
      )
    add(
      'test-targets',
      '测试目标版本',
      tested,
      tested ? '测试使用的配置与凭据版本仍有效' : '缺少有效测试记录，或配置与凭据已变化，请重新测试'
    )
  }
  const deploymentResult = await database
    .from('bff_interface_deployments')
    .select('interface_id')
    .eq('tenant_id', session.member.tenant_id)
    .eq('application_id', record.applicationId)
    .eq('environment', record.environment)
    .eq('enabled', true)
    .eq('method', snapshot.method)
    .eq('route_shape', snapshot.path.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '{}'))
    .neq('interface_id', record.interfaceId)
    .limit(1)
  failure(deploymentResult.error)
  add(
    'route',
    '入口路径',
    !deploymentResult.data?.length,
    deploymentResult.data?.length ? '该方法与路径已有其他生效接口' : '当前路径没有生效接口冲突'
  )
  return {
    record,
    snapshot,
    readiness: { ready: checks.every((check) => check.passed), checks },
    observations: [...observed.values()]
  }
}
export async function releaseReadiness(
  session: Session,
  id: string,
  url: URL
): Promise<ReleaseReadiness> {
  const purpose = url.searchParams.get('purpose') || 'publish'
  if (purpose !== 'publish' && purpose !== 'rollback' && purpose !== 'enable')
    throw new HttpError(400, '发布检查类型无效')
  const targetVersionId = url.searchParams.get('targetVersionId')
    ? uuid(url.searchParams.get('targetVersionId')!).toLowerCase()
    : undefined
  if (purpose === 'rollback' && !targetVersionId) throw new HttpError(400, '请选择回滚版本')
  return (await prepareRelease(session, id, purpose, targetVersionId)).readiness
}
export async function writeRelease(
  req: IncomingMessage,
  session: Session,
  id: string,
  action: 'publish' | 'rollback' | 'status'
): Promise<ReleaseHistory> {
  requireMutation(req, session)
  const input = await body(req)
  let operation: ReleaseOperation = action === 'status' ? 'disable' : action
  if (action === 'status') {
    if (typeof input.enabled !== 'boolean') throw new HttpError(400, '请选择有效的发布状态')
    operation = input.enabled ? 'enable' : 'disable'
  }
  const command = releaseCommandInput(input, operation)
  let observations: ReleaseUpstreamObservation[] = []
  let record: ReleaseRecord
  if (operation === 'disable') record = await target(session, id, permissions.disable)
  else {
    const prepared = await prepareRelease(session, id, operation, command.targetVersionId)
    record = prepared.record
    if (!prepared.readiness.ready)
      throw new HttpError(
        409,
        prepared.readiness.checks.find((check) => !check.passed)?.message || '发布前检查未通过'
      )
    observations = prepared.observations
  }
  if (
    (record.deployment?.version ?? 0) !== command.deploymentVersion ||
    (operation === 'publish' && command.draftVersion !== record.draftVersion)
  )
    throw new HttpError(409, '草稿或发布状态已变化，请刷新后重试')
  const result = await database.rpc('bff_write_release', {
    p_actor: session.member.id,
    p_operation: operation,
    p_interface: record.interfaceId,
    p_draft_version: command.draftVersion ?? null,
    p_deployment_version: command.deploymentVersion,
    p_target_version: command.targetVersionId ?? null,
    p_notes: command.notes,
    p_upstream_versions: observations
  })
  failure(result.error)
  return releaseHistoryDto(result.data)
}
