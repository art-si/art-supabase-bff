import type { IncomingMessage } from 'node:http'
import { jwtVerify } from 'jose'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type { Member } from './auth'
import { uuid } from './applications'
import { config } from './config'
import { database } from './database/client'
import { parseProBridgeInvocation } from './gateway'
import { body, HttpError } from './http'
import { digest, safeEqual } from './security'

export const PRO_BRIDGE_ISSUER = 'https://ckbftoopuyophiebamwy.supabase.co/auth/v1'
export const PRO_BRIDGE_AUDIENCE = 'bff-pro-bridge'
export const PRO_BRIDGE_TYPE = 'bff-pro-bridge+jwt'

/** Dedicated server-to-server key. A browser or a session key is never a signer. */
function signingKey(secret: string): Uint8Array {
  const key = Buffer.from(secret, 'base64')
  if (key.length !== 32 || key.toString('base64') !== secret)
    throw new HttpError(503, 'Pro 接入尚未配置完成，请联系部署管理员', 'BRIDGE_NOT_CONFIGURED')
  return key
}

export async function verifyProBridgeAssertion(
  assertion: string,
  payload: unknown,
  secret = config.proBridgeSecret,
  currentDate = new Date()
): Promise<{ subject: string; nonceHash: string; expiresAt: string }> {
  const key = signingKey(secret)
  if (assertion.length < 100 || assertion.length > 8192)
    throw new HttpError(401, 'Pro 接入身份校验失败，请重新发起调用', 'BRIDGE_UNAUTHORIZED')
  try {
    const { payload: claims } = await jwtVerify(assertion, key, {
      algorithms: ['HS256'],
      issuer: PRO_BRIDGE_ISSUER,
      audience: PRO_BRIDGE_AUDIENCE,
      typ: PRO_BRIDGE_TYPE,
      currentDate,
      clockTolerance: 3,
      maxTokenAge: 65
    })
    const now = Math.floor(currentDate.getTime() / 1000)
    if (
      typeof claims.sub !== 'string' ||
      typeof claims.jti !== 'string' ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > 60 ||
      claims.iat > now + 3 ||
      claims.exp <= now ||
      typeof claims.bodyHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(claims.bodyHash) ||
      !safeEqual(claims.bodyHash, digest(JSON.stringify(payload)))
    )
      throw new Error('Invalid bridge claims')
    const subject = uuid(claims.sub)
    const nonce = uuid(claims.jti)
    return {
      subject,
      nonceHash: digest(`${PRO_BRIDGE_ISSUER}\0${subject}\0${nonce}`),
      expiresAt: new Date(claims.exp * 1000).toISOString()
    }
  } catch (cause) {
    throw new HttpError(401, 'Pro 接入身份校验失败，请重新发起调用', 'BRIDGE_UNAUTHORIZED', {
      cause
    })
  }
}

/** Verify signed intent, bind an active BFF membership, then atomically consume its nonce. */
export async function authenticateProBridge(req: IncomingMessage): Promise<{
  member: Member
  invocation: ReturnType<typeof parseProBridgeInvocation>
}> {
  const assertion = req.headers['x-bff-pro-assertion']
  if (typeof assertion !== 'string')
    throw new HttpError(401, '此接口仅接受已授权的 Pro 服务端调用', 'BRIDGE_UNAUTHORIZED')
  const payload = await body(req, 32768)
  const verified = await verifyProBridgeAssertion(assertion, payload)
  const invocation = parseProBridgeInvocation(payload)
  const result = await database
    .from('bff_members')
    .select('id,issuer,subject,tenant_id,display_name,email,role,enabled')
    .eq('issuer', PRO_BRIDGE_ISSUER)
    .eq('subject', verified.subject)
    .eq('enabled', true)
    .maybeSingle()
  if (result.error)
    throw new HttpError(
      503,
      '暂时无法检查 BFF 访问权限，请稍后重试',
      'BRIDGE_MEMBER_LOOKUP_UNAVAILABLE'
    )
  const row: unknown = result.data
  if (!row)
    throw new HttpError(403, '该统一账号尚未开通 BFF 访问，请联系工作空间管理员', 'BFF_FORBIDDEN')
  if (
    !isObjectRecord(row) ||
    row.issuer !== PRO_BRIDGE_ISSUER ||
    row.subject !== verified.subject ||
    row.enabled !== true ||
    (row.role !== 'admin' && row.role !== 'viewer') ||
    typeof row.display_name !== 'string' ||
    typeof row.email !== 'string'
  )
    throw new HttpError(503, 'BFF 访问身份暂不可用，请稍后重试', 'BRIDGE_UNAVAILABLE')
  const member: Member = {
    id: uuid(String(row.id)),
    tenant_id: uuid(String(row.tenant_id)),
    issuer: PRO_BRIDGE_ISSUER,
    subject: verified.subject,
    enabled: true,
    role: row.role,
    display_name: row.display_name,
    email: row.email
  }
  const consumed = await database.rpc('bff_consume_pro_bridge_nonce', {
    p_actor: member.id,
    p_nonce_hash: verified.nonceHash,
    p_expires_at: verified.expiresAt
  })
  if (consumed.error) {
    const known: Record<string, [number, string]> = {
      BFF_FORBIDDEN: [403, '当前账号的 BFF 访问已停用'],
      BFF_BRIDGE_INVALID_NONCE: [401, '本次调用凭证已失效，请重新发起调用'],
      BFF_BRIDGE_REPLAY: [409, '本次调用已被受理，请勿重复提交'],
      BFF_BRIDGE_RATE_LIMIT: [429, '调用较频繁，请稍后重试']
    }
    const failure = Object.hasOwn(known, consumed.error.message)
      ? known[consumed.error.message]
      : null
    if (failure) throw new HttpError(failure[0], failure[1], consumed.error.message)
    throw new HttpError(503, 'BFF 接入暂不可用，请稍后重试', 'BRIDGE_NONCE_UNAVAILABLE')
  }
  if (consumed.data !== true)
    throw new HttpError(503, 'BFF 接入暂不可用，请稍后重试', 'BRIDGE_NONCE_RESULT_INVALID')
  return { member, invocation }
}
