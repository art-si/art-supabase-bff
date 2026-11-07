import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type { InterfaceStep } from '../src/types/interface'
import type { PublishedExecution } from '../src/types/release'
import type { Member } from './auth'
import type { InterfaceStepTarget } from './interface-runner'
import { database } from './database/client'
import { HttpError } from './http'
import { normalizeUpstreamUrl, type UpstreamNetworkPolicy } from './upstream-network'
import { openUpstreamCredential, readUpstreamCredential, upstreamPolicy } from './upstream-runtime'

export interface ReleaseUpstreamObservation {
  id: string
  configVersion: number
  currentConfigVersion: number
  credentialVersion: number
}
export interface PublishedStepTarget extends InterfaceStepTarget {
  observed: ReleaseUpstreamObservation
}
async function timedRead<T>(query: PromiseLike<T>): Promise<{ result: T; durationMs: number }> {
  const started = Date.now()
  return { result: await query, durationMs: Date.now() - started }
}
function safeReadDiagnostic(value: { status: number; error: unknown }, durationMs: number) {
  const code =
    isObjectRecord(value.error) &&
    typeof value.error.code === 'string' &&
    /^[A-Z0-9_]{0,64}$/.test(value.error.code)
      ? value.error.code
      : ''
  return {
    status:
      Number.isInteger(value.status) && value.status >= 0 && value.status <= 599 ? value.status : 0,
    code,
    durationMs
  }
}
/** Decode only a server-authorized snapshot; this function never queries or returns sealed metadata. */
export function decodePublishedTarget(
  member: Pick<Member, 'tenant_id'>,
  execution: Pick<PublishedExecution, 'applicationId' | 'environment'>,
  step: InterfaceStep,
  value: unknown,
  requireCurrentConfig = false,
  policy: UpstreamNetworkPolicy = upstreamPolicy
): PublishedStepTarget {
  if (
    !isObjectRecord(value) ||
    value.stepKey !== step.key ||
    value.id !== step.upstreamId ||
    value.configVersion !== step.configVersion ||
    typeof value.currentConfigVersion !== 'number' ||
    !Number.isSafeInteger(value.currentConfigVersion) ||
    value.currentConfigVersion < 1 ||
    typeof value.credentialVersion !== 'number' ||
    !Number.isSafeInteger(value.credentialVersion) ||
    value.credentialVersion < 0 ||
    typeof value.baseUrl !== 'string' ||
    typeof value.timeoutMs !== 'number' ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 100 ||
    value.timeoutMs > 30_000 ||
    (value.authType !== 'none' &&
      value.authType !== 'bearer' &&
      value.authType !== 'api_key_header') ||
    typeof value.headerName !== 'string'
  )
    throw new HttpError(503, '发布目标数据暂不可用，请稍后重试')
  if (requireCurrentConfig && value.currentConfigVersion !== step.configVersion)
    throw new HttpError(409, '上游配置版本已变化，请更新草稿并重新测试')
  let baseUrl: string
  try {
    baseUrl = normalizeUpstreamUrl(value.baseUrl, policy)
  } catch {
    throw new HttpError(409, '发布版本的上游地址未通过当前网络策略，请联系管理员')
  }
  const credential = openUpstreamCredential(
    {
      tenantId: member.tenant_id,
      applicationId: execution.applicationId,
      serviceId: step.upstreamId,
      version: value.credentialVersion,
      authType: value.authType,
      headerName: value.headerName
    },
    value.credential
  )
  return {
    baseUrl,
    timeoutMs: value.timeoutMs,
    credential,
    observed: {
      id: step.upstreamId,
      configVersion: step.configVersion,
      currentConfigVersion: value.currentConfigVersion,
      credentialVersion: value.credentialVersion
    }
  }
}
/** Shared publish/rollback/invocation check; callers authorize the owning interface first. */
export async function loadPublishedTarget(
  member: Pick<Member, 'tenant_id'>,
  execution: Pick<PublishedExecution, 'applicationId' | 'environment'>,
  step: InterfaceStep,
  options: { requireCurrentConfig?: boolean; remainingMs?: number } = {}
): Promise<PublishedStepTarget> {
  const started = Date.now(),
    budget = Math.max(1, options.remainingMs ?? 30_000)
  const signal = AbortSignal.timeout(budget)
  const [masterRead, pinnedRead] = await Promise.all([
    timedRead(
      database
        .from('bff_upstream_services')
        .select('id,status,config_version,credential_version,auth_type,header_name')
        .eq('id', step.upstreamId)
        .eq('tenant_id', member.tenant_id)
        .eq('application_id', execution.applicationId)
        .eq('environment', execution.environment)
        .is('deleted_at', null)
        .abortSignal(signal)
        .maybeSingle()
    ),
    timedRead(
      database
        .from('bff_upstream_service_revisions')
        .select('service_id,config_version,base_url,auth_type,header_name,timeout_ms')
        .eq('service_id', step.upstreamId)
        .eq('config_version', step.configVersion)
        .eq('tenant_id', member.tenant_id)
        .eq('application_id', execution.applicationId)
        .eq('environment', execution.environment)
        .abortSignal(signal)
        .maybeSingle()
    )
  ])
  const masterResult = masterRead.result,
    pinnedResult = pinnedRead.result
  if (masterResult.error || pinnedResult.error) {
    console.warn('[BFF] published target read failed', {
      master: safeReadDiagnostic(masterResult, masterRead.durationMs),
      pinned: safeReadDiagnostic(pinnedResult, pinnedRead.durationMs)
    })
    throw new HttpError(503, '上游配置暂时无法读取，请稍后重试')
  }
  const master: unknown = masterResult.data,
    pinned: unknown = pinnedResult.data
  if (!isObjectRecord(master) || !isObjectRecord(pinned) || master.status !== 'active')
    throw new HttpError(409, '绑定的上游服务尚未启用或已归档')
  if (
    typeof master.id !== 'string' ||
    typeof master.config_version !== 'number' ||
    typeof master.credential_version !== 'number' ||
    typeof master.auth_type !== 'string' ||
    typeof master.header_name !== 'string' ||
    typeof pinned.base_url !== 'string' ||
    typeof pinned.timeout_ms !== 'number' ||
    typeof pinned.config_version !== 'number' ||
    typeof pinned.auth_type !== 'string' ||
    typeof pinned.header_name !== 'string'
  )
    throw new Error('Invalid published upstream target')
  if (options.requireCurrentConfig && master.config_version !== step.configVersion)
    throw new HttpError(409, '上游配置版本已变化，请更新草稿并重新测试')
  if (master.auth_type !== pinned.auth_type || master.header_name !== pinned.header_name)
    throw new HttpError(409, '当前凭据策略与发布版本不兼容，请调整上游配置后再操作')
  const remaining = budget - (Date.now() - started)
  if (remaining < 1) throw new HttpError(408, '上游就绪检查超时，请稍后重试')
  const credential = await readUpstreamCredential({
    tenantId: member.tenant_id,
    applicationId: execution.applicationId,
    serviceId: master.id,
    version: master.credential_version,
    authType: master.auth_type,
    headerName: master.header_name,
    timeoutMs: remaining
  })
  return decodePublishedTarget(
    member,
    execution,
    step,
    {
      stepKey: step.key,
      id: master.id,
      configVersion: pinned.config_version,
      currentConfigVersion: master.config_version,
      credentialVersion: master.credential_version,
      baseUrl: pinned.base_url,
      timeoutMs: pinned.timeout_ms,
      authType: pinned.auth_type,
      headerName: pinned.header_name,
      credential
    },
    options.requireCurrentConfig
  )
}
