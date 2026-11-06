import { config } from './config'
import { credentialKeyring } from './upstream-credentials'
import { validateUpstreamPolicy, type UpstreamNetworkPolicy } from './upstream-network'

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
