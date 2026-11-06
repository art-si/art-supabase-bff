import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type {
  UpstreamService,
  UpstreamList,
  UpstreamEnvironment,
  UpstreamAuthType,
  UpstreamOptions
} from '../src/types/upstream'
import { database } from './database/client'
import { type Session, requireMutation } from './auth'
import { body, HttpError } from './http'
import { uuid } from './applications'
import { controlFailure, revisionInput, text } from './control-plane'
import { encryptCredential, type EncryptedCredential } from './upstream-credentials'
import { isSafeCredentialHeader, normalizeUpstreamUrl, probeUpstream } from './upstream-network'
import {
  credentialsReady,
  loadUpstreamCredential,
  upstreamKeys,
  upstreamPolicy
} from './upstream-runtime'

const healthMessages: Record<string, string> = {
  reachable: '服务可连接；本次测试未验证业务凭据',
  invalid_url: '服务地址无效，请检查地址设置',
  invalid_policy: '网络访问策略配置有误，请联系管理员',
  invalid_timeout: '连接超时设置无效',
  target_not_allowed: '该服务地址尚未列入允许访问范围，请联系管理员',
  target_blocked: '该地址被网络安全策略阻止，请检查服务地址',
  dns_failed: '服务域名暂时无法解析，请稍后重试',
  connection_failed: '暂时无法连接服务，请检查地址、证书或网络',
  timeout: '连接测试超时，请检查服务状态',
  redirect_blocked: '服务返回重定向，请配置最终服务地址',
  response_too_large: '测试响应超过大小限制',
  stale: '配置已更新，请按最新配置重新测试'
}
function failure(error: { code?: string; message?: string } | null): void {
  const messages: Record<string, string> = {
    BFF_UPSTREAM_ACTIVE: '请先停用服务，再清除凭据或删除配置',
    BFF_UPSTREAM_CREDENTIAL_REQUIRED: '请先配置服务凭据，再启用服务',
    BFF_UPSTREAM_REQUIRES_CREDENTIAL: '服务认证配置需要有效的凭据，请检查后重试',
    BFF_UPSTREAM_NOT_READY: '请确认所属应用已启用，且服务凭据已配置',
    BFF_UPSTREAM_APPLICATION_DISABLED: '所属应用已停用，请先启用应用',
    BFF_UPSTREAM_IMMUTABLE: '服务编码、所属应用和环境创建后不可变更',
    BFF_UPSTREAM_IDENTITY_IMMUTABLE: '服务编码、所属应用和环境创建后不可变更'
  }
  if (error?.message && Object.hasOwn(messages, error.message))
    throw new HttpError(409, messages[error.message], error.message)
  controlFailure(error)
}
/** Explicit public projection: adding a DB field can never expose encrypted credentials. */
export function upstreamDto(value: unknown): UpstreamService {
  if (!isObjectRecord(value) || !isObjectRecord(value.application))
    throw new Error('Invalid upstream response')
  const {
    id,
    applicationId,
    code,
    name,
    description,
    environment,
    status,
    baseUrl,
    authType,
    headerName,
    timeoutMs,
    version,
    configVersion,
    credentialConfigured,
    credentialVersion,
    healthStatus,
    lastCheckedAt,
    lastStatusCode,
    lastDurationMs,
    lastHealthCode,
    createdAt,
    updatedAt
  } = value
  const application = value.application
  if (
    typeof id !== 'string' ||
    typeof applicationId !== 'string' ||
    typeof code !== 'string' ||
    typeof name !== 'string' ||
    typeof description !== 'string' ||
    (environment !== 'development' && environment !== 'staging' && environment !== 'production') ||
    (status !== 'draft' && status !== 'active' && status !== 'disabled') ||
    typeof baseUrl !== 'string' ||
    (authType !== 'none' && authType !== 'bearer' && authType !== 'api_key_header') ||
    typeof headerName !== 'string' ||
    typeof timeoutMs !== 'number' ||
    typeof version !== 'number' ||
    typeof configVersion !== 'number' ||
    typeof credentialConfigured !== 'boolean' ||
    typeof credentialVersion !== 'number' ||
    (healthStatus !== 'unknown' &&
      healthStatus !== 'reachable' &&
      healthStatus !== 'failed' &&
      healthStatus !== 'stale') ||
    (lastCheckedAt !== null && typeof lastCheckedAt !== 'string') ||
    (lastStatusCode !== null && typeof lastStatusCode !== 'number') ||
    (lastDurationMs !== null && typeof lastDurationMs !== 'number') ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    typeof application.id !== 'string' ||
    typeof application.code !== 'string' ||
    typeof application.name !== 'string' ||
    typeof application.enabled !== 'boolean'
  )
    throw new Error('Invalid upstream response')
  return {
    id,
    applicationId,
    application: {
      id: application.id,
      code: application.code,
      name: application.name,
      enabled: application.enabled
    },
    code,
    name,
    description,
    environment,
    status,
    baseUrl,
    authType,
    headerName,
    timeoutMs,
    version,
    configVersion,
    credentialConfigured,
    credentialVersion,
    healthStatus,
    lastCheckedAt,
    lastStatusCode,
    lastDurationMs,
    lastHealthMessage:
      value.stale === true
        ? '配置已变化，本次旧结果未应用，请重新测试'
        : healthStatus === 'stale'
          ? healthMessages.stale
          : typeof lastHealthCode === 'string' && Object.hasOwn(healthMessages, lastHealthCode)
            ? healthMessages[lastHealthCode]
            : '尚未完成连接测试',
    ...(value.stale === true ? { probeStale: true } : {}),
    createdAt,
    updatedAt
  }
}
function environment(value: unknown): UpstreamEnvironment {
  if (value !== 'development' && value !== 'staging' && value !== 'production')
    throw new HttpError(400, '请选择有效的运行环境')
  return value
}
export function upstreamInput(
  value: Record<string, unknown>,
  create: boolean
): Record<string, unknown> {
  const authType = value.authType
  if (authType !== 'none' && authType !== 'bearer' && authType !== 'api_key_header')
    throw new HttpError(400, '请选择有效的认证方式')
  const timeoutMs = value.timeoutMs
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 30000
  )
    throw new HttpError(400, '连接超时需为 100–30000 毫秒')
  let baseUrl: string
  try {
    const candidate = text(value.baseUrl, '服务地址', 2000, true)
    // Draft metadata can be prepared before an operator enables outbound access.
    // Plain HTTP stays limited to an explicitly allowlisted local test endpoint.
    baseUrl = candidate.toLowerCase().startsWith('http:')
      ? normalizeUpstreamUrl(candidate, upstreamPolicy)
      : normalizeUpstreamUrl(candidate)
  } catch {
    throw new HttpError(400, '请填写有效的 HTTPS 服务地址，不得包含账号、查询参数或锚点')
  }
  const headerName =
    authType === 'bearer'
      ? 'Authorization'
      : authType === 'none'
        ? ''
        : text(value.headerName, '凭据请求头', 64, true)
  if (authType === 'api_key_header' && !isSafeCredentialHeader(headerName))
    throw new HttpError(
      400,
      '请使用独立的 API Key 请求头，不得覆盖认证、Cookie、路由或连接控制字段'
    )
  const result: Record<string, unknown> = {
    name: text(value.name, '服务名称', 100, true),
    description: text(value.description, '服务说明', 1000),
    baseUrl,
    authType,
    headerName,
    timeoutMs
  }
  if (create) {
    const code = text(value.code, '服务编码', 64, true)
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(code))
      throw new HttpError(400, '服务编码需为 2–64 位小写字母、数字或连字符，并以字母开头')
    Object.assign(result, {
      applicationId: uuid(String(value.applicationId)),
      code,
      environment: environment(value.environment)
    })
  }
  return result
}
function encryptedInput(
  secret: unknown,
  authType: UpstreamAuthType,
  session: Session,
  id: string,
  applicationId: string,
  version: number
): EncryptedCredential | null {
  if (secret === undefined || secret === '') return null
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(secret))
    throw new HttpError(400, '凭据需为可见英文字符，不能包含空格、换行或控制字符')
  if (authType === 'none') throw new HttpError(400, '无需认证的服务不能保存凭据')
  if (!credentialsReady) throw new HttpError(503, '服务端尚未完成凭据加密配置，请联系管理员')
  return encryptCredential(
    secret,
    { tenantId: session.member.tenant_id, applicationId, serviceId: id, version },
    upstreamKeys
  )
}
async function target(session: Session, id: string, permission: string): Promise<UpstreamService> {
  const result = await database.rpc('bff_upstream_target', {
    p_actor: session.member.id,
    p_id: uuid(id),
    p_permission: permission
  })
  failure(result.error)
  return upstreamDto(result.data)
}
async function requireUsableCredential(session: Session, record: UpstreamService): Promise<void> {
  await loadUpstreamCredential({
    tenantId: session.member.tenant_id,
    applicationId: record.applicationId,
    serviceId: record.id,
    version: record.credentialVersion,
    authType: record.authType,
    headerName: record.headerName
  })
}
export async function listUpstreams(session: Session, url: URL): Promise<UpstreamList> {
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
  if (url.searchParams.get('environment'))
    filters.environment = environment(url.searchParams.get('environment'))
  const status = url.searchParams.get('status')
  if (status) {
    if (!['draft', 'active', 'disabled'].includes(status)) throw new HttpError(400, '服务状态无效')
    filters.status = status
  }
  const result = await database.rpc('bff_read_upstreams', {
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
    throw new Error('Invalid upstream list')
  const summary = data.summary
  if (
    typeof summary.total !== 'number' ||
    typeof summary.active !== 'number' ||
    typeof summary.draft !== 'number' ||
    typeof summary.disabled !== 'number' ||
    typeof summary.reachable !== 'number' ||
    typeof summary.failed !== 'number'
  )
    throw new Error('Invalid upstream summary')
  return {
    records: data.records.map(upstreamDto),
    total: data.total,
    current,
    size,
    summary: {
      total: summary.total,
      active: summary.active,
      draft: summary.draft,
      disabled: summary.disabled,
      reachable: summary.reachable,
      failed: summary.failed
    }
  }
}
export async function upstreamOptions(session: Session): Promise<UpstreamOptions> {
  const result = await database.rpc('bff_upstream_options', { p_actor: session.member.id })
  failure(result.error)
  if (
    !isObjectRecord(result.data) ||
    !Array.isArray(result.data.applications) ||
    !Array.isArray(result.data.environments)
  )
    throw new Error('Invalid upstream options')
  return {
    applications: result.data.applications.map((app: unknown) => {
      if (
        !isObjectRecord(app) ||
        typeof app.id !== 'string' ||
        typeof app.code !== 'string' ||
        typeof app.name !== 'string' ||
        typeof app.enabled !== 'boolean'
      )
        throw new Error('Invalid upstream application')
      return { id: app.id, code: app.code, name: app.name, enabled: app.enabled }
    }),
    environments: result.data.environments.map((item: unknown) => {
      if (
        !isObjectRecord(item) ||
        typeof item.label !== 'string' ||
        (item.value !== 'development' && item.value !== 'staging' && item.value !== 'production')
      )
        throw new Error('Invalid upstream environment')
      return { value: item.value, label: item.label }
    }),
    credentialManagementReady: credentialsReady,
    networkPolicyConfigured: upstreamPolicy.allowedOrigins.length > 0
  }
}
export async function saveUpstream(
  req: IncomingMessage,
  session: Session,
  id?: string
): Promise<UpstreamService> {
  requireMutation(req, session)
  const input = await body(req, 32768),
    definition = upstreamInput(input, !id)
  const original = id ? await target(session, id, 'BffUpstream:Edit') : null
  const serviceId = id ? uuid(id) : randomUUID()
  const authType = definition.authType
  if (authType !== 'none' && authType !== 'bearer' && authType !== 'api_key_header')
    throw new Error('Invalid normalized auth')
  const applicationId = original?.applicationId || uuid(String(definition.applicationId))
  const credential = encryptedInput(
    input.credential,
    authType,
    session,
    serviceId,
    applicationId,
    (original?.credentialVersion || 0) + 1
  )
  if (original?.status === 'active') {
    if (!upstreamPolicy.allowedOrigins.includes(new URL(String(definition.baseUrl)).origin))
      throw new HttpError(409, '启用中的服务只能使用已允许的地址，请先停用或配置网络策略')
    if (!credential && authType !== 'none') await requireUsableCredential(session, original)
  }
  const result = await database.rpc('bff_write_upstream', {
    p_actor: session.member.id,
    p_operation: id ? 'update' : 'create',
    p_id: serviceId,
    p_version: id ? revisionInput(input.version) : null,
    p_definition: definition,
    p_credential: credential
  })
  failure(result.error)
  return upstreamDto(result.data)
}
export async function changeUpstream(
  req: IncomingMessage,
  session: Session,
  id: string,
  operation: 'status' | 'credential' | 'delete'
): Promise<unknown> {
  requireMutation(req, session)
  const input = await body(req, 32768),
    version = revisionInput(input.version)
  let definition: Record<string, unknown> = {},
    credential: EncryptedCredential | { clear: true } | null = null
  if (operation === 'status') {
    if (input.status !== 'active' && input.status !== 'disabled')
      throw new HttpError(400, '请选择启用或停用')
    const record = await target(session, id, 'BffUpstream:ChangeStatus')
    if (record.version !== version) throw new HttpError(409, '服务已更新，请刷新后重试')
    if (
      input.status === 'active' &&
      !upstreamPolicy.allowedOrigins.includes(new URL(record.baseUrl).origin)
    )
      throw new HttpError(409, '该服务地址尚未列入允许访问范围，请联系管理员')
    if (input.status === 'active') await requireUsableCredential(session, record)
    definition = { status: input.status }
  } else if (operation === 'credential') {
    const record = await target(session, id, 'BffUpstream:RotateSecret')
    if (input.action === 'clear') credential = { clear: true }
    else if (input.action === 'rotate') {
      credential = encryptedInput(
        input.credential,
        record.authType,
        session,
        id,
        record.applicationId,
        record.credentialVersion + 1
      )
      if (!credential) throw new HttpError(400, '请填写新的服务凭据')
    } else throw new HttpError(400, '凭据操作无效')
  }
  const result = await database.rpc('bff_write_upstream', {
    p_actor: session.member.id,
    p_operation: operation,
    p_id: uuid(id),
    p_version: version,
    p_definition: definition,
    p_credential: credential
  })
  failure(result.error)
  return operation === 'delete' ? { saved: true } : upstreamDto(result.data)
}
export async function upstreamReferences(session: Session, id: string): Promise<unknown> {
  const result = await database.rpc('bff_upstream_references', {
    p_actor: session.member.id,
    p_id: uuid(id)
  })
  failure(result.error)
  return result.data
}
const activeProbes = new Set<string>()
export async function testUpstream(
  req: IncomingMessage,
  session: Session,
  id: string
): Promise<UpstreamService> {
  requireMutation(req, session)
  const input = await body(req),
    version = revisionInput(input.version)
  const record = await target(session, id, 'BffUpstream:Test')
  if (record.version !== version) throw new HttpError(409, '服务已更新，请刷新后测试')
  if (
    activeProbes.has(record.id) ||
    activeProbes.size >= 8 ||
    (record.lastCheckedAt && Date.now() - Date.parse(record.lastCheckedAt) < 5000)
  )
    throw new HttpError(429, '连接测试过于频繁，请稍后再试')
  activeProbes.add(record.id)
  try {
    const probe = await probeUpstream(record.baseUrl, record.timeoutMs, upstreamPolicy)
    const result = await database.rpc('bff_record_upstream_probe', {
      p_actor: session.member.id,
      p_id: uuid(id),
      p_version: version,
      p_result: probe
    })
    failure(result.error)
    return upstreamDto(result.data)
  } finally {
    activeProbes.delete(record.id)
  }
}
