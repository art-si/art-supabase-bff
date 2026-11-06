import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { seal, unseal } from './security'

export interface CredentialKeyring {
  activeId: string
  keys: ReadonlyMap<string, string>
}
export interface CredentialContext {
  tenantId: string
  applicationId: string
  serviceId: string
  version: number
}
export interface EncryptedCredential {
  ciphertext: string
  keyId: string
  version: number
}

export function credentialKeyring(serialized = '{}', activeId = 'v1'): CredentialKeyring {
  let value: unknown
  try {
    value = JSON.parse(serialized || '{}')
  } catch {
    // JSON syntax errors may quote secret-bearing input.
    throw new Error('凭据密钥集合不是有效的 JSON 配置')
  }
  if (!isObjectRecord(value) || Object.keys(value).length > 8)
    throw new Error('凭据加密配置需为最多 8 个版本的密钥集合')
  const keys = new Map<string, string>()
  for (const [id, key] of Object.entries(value)) {
    if (
      !/^[a-zA-Z0-9_-]{1,40}$/.test(id) ||
      typeof key !== 'string' ||
      Buffer.from(key, 'base64').length !== 32 ||
      Buffer.from(key, 'base64').toString('base64') !== key
    )
      throw new Error('凭据密钥标识无效，或密钥不是 32 字节的 Base64 编码')
    keys.set(id, key)
  }
  if (keys.size && !keys.has(activeId)) throw new Error('当前凭据密钥版本未配置')
  return { activeId, keys }
}

function contextData(context: CredentialContext): string {
  if (
    !Number.isSafeInteger(context.version) ||
    context.version < 1 ||
    [context.tenantId, context.applicationId, context.serviceId].some(
      (value) => !value || value.length > 128
    )
  )
    throw new Error('凭据归属或版本无效')
  return JSON.stringify({
    domain: 'bff-upstream-credential',
    tenantId: context.tenantId,
    applicationId: context.applicationId,
    serviceId: context.serviceId,
    version: context.version
  })
}
export function encryptCredential(
  secret: string,
  context: CredentialContext,
  keyring: CredentialKeyring
): EncryptedCredential {
  const key = keyring.keys.get(keyring.activeId)
  if (!key) throw new Error('服务端尚未配置凭据加密密钥')
  if (!/^[\x21-\x7e]{1,8192}$/.test(secret))
    throw new Error('凭据需为可见英文字符，不能包含空格、换行或控制字符')
  return {
    ciphertext: seal(secret, key, contextData(context)),
    keyId: keyring.activeId,
    version: context.version
  }
}
export function decryptCredential(
  encrypted: EncryptedCredential,
  context: CredentialContext,
  keyring: CredentialKeyring
): string {
  const key = keyring.keys.get(encrypted.keyId)
  if (!key || encrypted.version !== context.version) throw new Error('服务凭据的密钥或版本不可用')
  try {
    const secret: unknown = unseal(encrypted.ciphertext, key, contextData(context))
    if (typeof secret !== 'string') throw new Error('Invalid credential data')
    return secret
  } catch (cause) {
    throw new Error('服务凭据校验失败，请管理员核对密钥配置', { cause })
  }
}
