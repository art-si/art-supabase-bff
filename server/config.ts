import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { expand } from 'dotenv-expand'

const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production')
const mode = production ? 'production' : 'development'
const parsed: Record<string, string> = Object.assign(
  {},
  ...['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]
    .map((file) => path.resolve(file))
    .filter(existsSync)
    .map((file) => parse(readFileSync(file)))
)
const inherited = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
)
const env = {
  ...expand({ parsed, processEnv: { ...parsed, ...inherited } }).parsed,
  ...process.env
}
const port = Number(env.BFF_PORT || env.PORT || 3010)
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BFF_PORT 必须为有效端口')

/** The public origin is configured by the operator, never taken from request Host headers. */
export function resolveBffOrigin(
  value: string | undefined,
  isProduction: boolean,
  listenPort: number
): string {
  if (!value && isProduction) throw new Error('生产部署必须配置 BFF_ORIGIN 为 BFF 的 HTTPS 域名')
  const target = new URL(value || `http://localhost:${listenPort}`)
  const localHttp =
    target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  if (
    target.username ||
    target.password ||
    target.pathname !== '/' ||
    target.search ||
    target.hash ||
    (target.protocol !== 'https:' && (!localHttp || isProduction))
  )
    throw new Error('BFF_ORIGIN 必须为 HTTPS 源站地址；本地开发可使用 localhost 的 HTTP 地址')
  return target.origin
}
const origin = resolveBffOrigin(
  env.BFF_ORIGIN || env.RENDER_EXTERNAL_URL || (env.NETLIFY === 'true' ? env.URL : undefined),
  production,
  port
)
const alertWorkerIntervalMs = Number(env.BFF_ALERT_WORKER_INTERVAL_MS || 60_000)
if (
  !Number.isSafeInteger(alertWorkerIntervalMs) ||
  alertWorkerIntervalMs < 30_000 ||
  alertWorkerIntervalMs > 900_000
)
  throw new Error('BFF_ALERT_WORKER_INTERVAL_MS 必须在 30000–900000 毫秒之间')
export const config = {
  port,
  host: env.BFF_HOST || '127.0.0.1',
  origin,
  browserOutputDir: env.VITE_OUT_DIR || 'docs',
  issuer: env.BFF_AUTH_ISSUER || 'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',
  authorizationUi:
    env.BFF_AUTH_UI_URL || 'https://art-si.github.io/art-supabase-pro/#/auth/oauth-consent',
  clientId: env.BFF_AUTH_CLIENT_ID || '',
  clientSecret: env.BFF_AUTH_CLIENT_SECRET || '',
  sessionKey: env.BFF_SESSION_KEY || '',
  databaseUrl: env.BFF_SUPABASE_URL || '',
  databaseKey: env.BFF_SUPABASE_SERVICE_KEY || '',
  identityDirectoryKey: env.BFF_IDENTITY_DIRECTORY_SERVICE_KEY || '',
  credentialKeys: env.BFF_CREDENTIAL_KEYS || '{}',
  credentialKeyId: env.BFF_CREDENTIAL_KEY_ID || 'v1',
  upstreamAllowedOrigins: env.BFF_UPSTREAM_ALLOWED_ORIGINS || '',
  upstreamAllowedCidrs: env.BFF_UPSTREAM_ALLOWED_CIDRS || '',
  upstreamAllowLocalHttp: env.BFF_UPSTREAM_ALLOW_LOCAL_HTTP === 'true',
  interfaceTestWriteOrigins: env.BFF_INTERFACE_TEST_WRITE_ORIGINS || '',
  alertWorkerIntervalMs,
  production
}

export function authReady(): boolean {
  return Boolean(config.clientId && config.sessionKey && config.databaseUrl && config.databaseKey)
}
