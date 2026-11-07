import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type { InterfaceStep } from '../src/types/interface'
import type { PublishedExecution } from '../src/types/release'
import type { Member } from './auth'
import type { InterfaceStepTarget } from './interface-runner'
import { HttpError } from './http'
import { normalizeUpstreamUrl, type UpstreamNetworkPolicy } from './upstream-network'
import { openUpstreamCredential, upstreamPolicy } from './upstream-runtime'

export interface ReleaseUpstreamObservation {
  id: string
  configVersion: number
  currentConfigVersion: number
  credentialVersion: number
}
export interface PublishedStepTarget extends InterfaceStepTarget {
  observed: ReleaseUpstreamObservation
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
