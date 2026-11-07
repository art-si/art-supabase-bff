import { config } from './config'
import {
  credentialKeyring,
  decryptCredential,
  type CredentialContext
} from './upstream-credentials'
import {
  isSafeCredentialHeader,
  validateUpstreamPolicy,
  type UpstreamNetworkPolicy
} from './upstream-network'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { database } from './database/client'
import { HttpError } from './http'

export const upstreamKeys = credentialKeyring(config.credentialKeys, config.credentialKeyId)
if (config.sessionKey && [...upstreamKeys.keys.values()].includes(config.sessionKey))
  throw new Error('上游凭据加密必须使用独立于会话的密钥')

export const upstreamPolicy: UpstreamNetworkPolicy = {
  allowedOrigins: config.upstreamAllowedOrigins
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  allowedCidrs: config.upstreamAllowedCidrs
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  allowLocalHttp: config.upstreamAllowLocalHttp,
  production: config.production
}
try {
  validateUpstreamPolicy(upstreamPolicy)
} catch (cause) {
  throw new Error('上游网络访问策略无效，请检查允许源站、CIDR 和本地测试开关', { cause })
}
export const credentialsReady = upstreamKeys.keys.has(upstreamKeys.activeId)
export const interfaceWriteTestOrigins = config.interfaceTestWriteOrigins
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
if (interfaceWriteTestOrigins.some((origin) => !upstreamPolicy.allowedOrigins.includes(origin)))
  throw new Error('写操作试运行源站必须同时列入上游网络允许范围')

type RuntimeCredentialContext = CredentialContext & {
  authType: string
  headerName: string
  timeoutMs?: number
}

/** Server-only encrypted metadata; authorize the owning application before reading. */
export async function readUpstreamCredential(context: RuntimeCredentialContext): Promise<unknown> {
  if (context.authType === 'none') return undefined
  const result = await database
    .from('bff_upstream_credentials')
    .select('ciphertext,keyId:key_id,version:credential_version')
    .eq('service_id', context.serviceId)
    .eq('tenant_id', context.tenantId)
    .eq('application_id', context.applicationId)
    .eq('credential_version', context.version)
    .abortSignal(AbortSignal.timeout(Math.max(1, context.timeoutMs ?? 30_000)))
    .maybeSingle()
  if (result.error) throw new HttpError(503, '服务凭据暂时无法读取，请稍后重试')
  return result.data
}

/** One decryption/header policy for direct reads and authorized batched target snapshots. */
export function openUpstreamCredential(
  context: RuntimeCredentialContext,
  value: unknown
): { headerName: string; value: string } | undefined {
  if (context.authType === 'none') return undefined
  if (!isObjectRecord(value)) throw new HttpError(409, '请先配置服务凭据，再启用或调用服务')
  try {
    if (
      typeof value.ciphertext !== 'string' ||
      typeof value.keyId !== 'string' ||
      typeof value.version !== 'number' ||
      value.version !== context.version ||
      !['bearer', 'api_key_header'].includes(context.authType) ||
      !isSafeCredentialHeader(context.headerName, context.authType === 'bearer')
    )
      throw new Error('Invalid credential record')
    const secret = decryptCredential(
      { ciphertext: value.ciphertext, keyId: value.keyId, version: value.version },
      context,
      upstreamKeys
    )
    if (!/^[\x21-\x7e]{1,8192}$/.test(secret)) throw new Error('Invalid credential contents')
    return {
      headerName: context.headerName,
      value: context.authType === 'bearer' ? `Bearer ${secret}` : secret
    }
  } catch {
    throw new HttpError(503, '服务凭据暂不可用，请管理员恢复对应密钥版本或重新配置凭据')
  }
}

export async function loadUpstreamCredential(
  context: RuntimeCredentialContext
): Promise<{ headerName: string; value: string } | undefined> {
  return openUpstreamCredential(context, await readUpstreamCredential(context))
}
