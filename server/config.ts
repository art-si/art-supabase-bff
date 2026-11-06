import { loadEnv } from 'vite'

const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production')
const env = {
  ...loadEnv(production ? 'production' : 'development', process.cwd(), ''),
  ...process.env
}
const port = Number(env.BFF_PORT || 3010)
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
const origin = resolveBffOrigin(env.BFF_ORIGIN, production, port)
export const config = {
  port,
  origin,
  issuer: env.BFF_AUTH_ISSUER || 'https://ckbftoopuyophiebamwy.supabase.co/auth/v1',
  authorizationUi:
    env.BFF_AUTH_UI_URL || 'https://art-si.github.io/art-supabase-pro/#/auth/oauth-consent',
  clientId: env.BFF_AUTH_CLIENT_ID || '',
  clientSecret: env.BFF_AUTH_CLIENT_SECRET || '',
  sessionKey: env.BFF_SESSION_KEY || '',
  databaseUrl: env.BFF_SUPABASE_URL || '',
  databaseKey: env.BFF_SUPABASE_SERVICE_KEY || '',
  production
}

export function authReady(): boolean {
  return Boolean(config.clientId && config.sessionKey && config.databaseUrl && config.databaseKey)
}
