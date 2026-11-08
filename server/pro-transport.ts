import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { keysToCamelDeep } from 'art-supabase-pro/src/utils/supabase/key-transform.ts'
import type { ProCertificateRisk, ProDispatchPreflight } from '../src/types/pro-transport'
import type { Session } from './auth'
import { uuid } from './applications'
import { config, resolveBffOrigin } from './config'
import { database } from './database/client'
import { controlFailure } from './control-plane'
import { HttpError } from './http'

const allowedOrigins = new Set(
  config.proIntegrationOrigins
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((origin) => resolveBffOrigin(origin, config.production, config.port))
)

/** CORS is restricted to this read-only integration endpoint and explicit pro origins. */
export function authorizeProIntegrationOrigin(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin
  if (origin && origin !== config.origin && !allowedOrigins.has(origin))
    throw new HttpError(403, '当前站点未获准访问业务集成服务')
  if (origin && (origin === config.origin || allowedOrigins.has(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }
}

function invalidResult(): never {
  throw new HttpError(503, '调度核验结果不完整，请稍后重试')
}
function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2000
}
export function parseProDispatchPreflight(
  advisories: unknown,
  certificates: unknown
): Pick<
  ProDispatchPreflight,
  'advisories' | 'certificateRisks' | 'certificateBlocked' | 'canOverrideCertificateRisk'
> {
  if (
    !Array.isArray(advisories) ||
    advisories.length > 100 ||
    !isObjectRecord(certificates) ||
    typeof certificates.blocked !== 'boolean' ||
    typeof certificates.canOverride !== 'boolean' ||
    !Array.isArray(certificates.risks) ||
    certificates.risks.length > 100
  )
    invalidResult()
  const safeAdvisories = advisories.map((value) => {
    if (!isObjectRecord(value) || !boundedText(value.subjectLabel) || !boundedText(value.message))
      invalidResult()
    return { subjectLabel: value.subjectLabel, message: value.message }
  })
  const risks = certificates.risks.map<ProCertificateRisk>((value) => {
    if (
      !isObjectRecord(value) ||
      (value.riskKind !== 'expired' && value.riskKind !== 'revoked') ||
      (value.subjectType !== 'vehicle' && value.subjectType !== 'driver') ||
      !boundedText(value.subjectId) ||
      !boundedText(value.subjectLabel) ||
      !boundedText(value.certificateType) ||
      (value.expiresOn !== null && !boundedText(value.expiresOn))
    )
      invalidResult()
    return {
      riskKind: value.riskKind,
      subjectType: value.subjectType,
      subjectId: value.subjectId,
      subjectLabel: value.subjectLabel,
      certificateType: value.certificateType,
      expiresOn: value.expiresOn
    }
  })
  if (certificates.blocked !== risks.length > 0) invalidResult()
  return {
    advisories: safeAdvisories,
    certificateRisks: risks,
    certificateBlocked: certificates.blocked,
    canOverrideCertificateRisk: certificates.canOverride
  }
}

/** All pro reads use the caller's own identity JWT and pro's existing secure RPCs. */
export async function readProDispatchPreflight(
  session: Session,
  url: URL
): Promise<ProDispatchPreflight> {
  if (url.searchParams.get('proSubject') !== session.member.subject)
    throw new HttpError(409, 'pro 与业务集成工作空间登录的账号不一致，请使用同一账号重新登录')
  const orderId = uuid(url.searchParams.get('orderId') || '')
  const vehicleId = url.searchParams.get('vehicleId')
    ? uuid(url.searchParams.get('vehicleId')!)
    : null
  const driverId = url.searchParams.get('driverId') ? uuid(url.searchParams.get('driverId')!) : null
  if (!vehicleId && !driverId) throw new HttpError(400, '请先选择车辆或司机')
  const tenantScope = uuid(url.searchParams.get('tenantScope') || '')
  const authorization = await database.rpc(
    'bff_pro_transport_context',
    { p_actor: session.member.id },
    { get: true }
  )
  controlFailure(authorization.error)
  if (!authorization.data) throw new HttpError(403, '未获准使用 pro 运输协同应用')
  if (!config.proPublicKey) throw new HttpError(503, '业务集成服务尚未配置完成，请联系管理员')
  if (session.tokens.subject !== session.member.subject || session.member.issuer !== config.issuer)
    throw new HttpError(401, '统一身份会话不一致，请重新登录')
  const headers: Record<string, string> = {
    apikey: config.proPublicKey,
    Authorization: `Bearer ${session.tokens.accessToken}`,
    'Content-Type': 'application/json'
  }
  headers['x-art-tenant-scope'] = tenantScope
  const deadline = AbortSignal.timeout(15000)
  async function readRpc(name: string, params: Record<string, string | null>): Promise<unknown> {
    const target = new URL(`/rest/v1/rpc/${name}`, config.issuer)
    let response: Response
    try {
      response = await fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: deadline,
        redirect: 'error'
      })
    } catch (cause) {
      throw new HttpError(503, 'pro 业务服务暂时无法连接，请稍后重试', 'PRO_UNAVAILABLE', { cause })
    }
    if (response.status === 401) throw new HttpError(401, '统一身份登录已过期，请重新登录')
    if (response.status === 403)
      throw new HttpError(403, '当前 pro 账号没有调度核验权限，或记录不在所选租户范围')
    if (response.status === 400)
      throw new HttpError(400, '所选 pro 租户或业务资源无效，请刷新范围后重新选择')
    if (!response.ok) throw new HttpError(503, 'pro 调度核验暂时不可用，请核对业务记录后重试')
    try {
      return keysToCamelDeep(await response.json())
    } catch (cause) {
      throw new HttpError(503, 'pro 核验结果无法读取，请稍后重试', 'PRO_INVALID_RESULT', { cause })
    }
  }
  const [advisories, certificates] = await Promise.all([
    readRpc('tms_check_dispatch_advisories_secure', {
      p_order_id: orderId,
      p_vehicle_id: vehicleId,
      p_driver_id: driverId
    }),
    readRpc('vms_check_dispatch_certificate_risk_secure', {
      p_vehicle_id: vehicleId,
      p_driver_id: driverId
    })
  ])
  return {
    requestId: randomUUID(),
    checkedAt: new Date().toISOString(),
    ...parseProDispatchPreflight(advisories, certificates)
  }
}
