import { config } from './config'
import {
  credentialKeyring,
  decryptCredential,
  type CredentialContext
} from './upstream-credentials'
import { validateUpstreamPolicy, type UpstreamNetworkPolicy } from './upstream-network'
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

/** Server-only; authorize the owning application before requesting a credential. */
export async function loadUpstreamCredential(
  context: CredentialContext & { authType: string; headerName: string; timeoutMs?: number }
): Promise<{ headerName: string; value: string } | undefined> {
  if (context.authType === 'none') return undefined
  const result = await database
    .from('bff_upstream_credentials')
    .select('ciphertext,key_id,credential_version')
    .eq('service_id', context.serviceId)
    .eq('tenant_id', context.tenantId)
    .eq('application_id', context.applicationId)
    .eq('credential_version', context.version)
    .abortSignal(AbortSignal.timeout(Math.max(1, context.timeoutMs ?? 30_000)))
    .maybeSingle()
  if (result.error) throw new HttpError(503, '服务凭据暂时无法读取，请稍后重试')
  const value: unknown = result.data
  if (!isObjectRecord(value)) throw new HttpError(409, '请先配置服务凭据，再启用或调用服务')
  try {
    if (
      typeof value.ciphertext !== 'string' ||
      typeof value.key_id !== 'string' ||
      typeof value.credential_version !== 'number'
    )
      throw new Error('Invalid credential record')
    const secret = decryptCredential(
      { ciphertext: value.ciphertext, keyId: value.key_id, version: value.credential_version },
      context,
      upstreamKeys
    )
    return {
      headerName: context.headerName,
      value: context.authType === 'bearer' ? `Bearer ${secret}` : secret
    }
  } catch {
    throw new HttpError(503, '服务凭据暂不可用，请管理员恢复对应密钥版本或重新配置凭据')
  }
}
