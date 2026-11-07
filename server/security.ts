import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'

export function opaqueToken(): string {
  return randomBytes(32).toString('base64url')
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
export function seal(value: unknown, encodedKey: string, additionalData?: string): string {
  const key = Buffer.from(encodedKey, 'base64')
  if (key.length !== 32) throw new Error('BFF_SESSION_KEY 必须为 32 字节的 Base64 编码')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  if (additionalData !== undefined) cipher.setAAD(Buffer.from(additionalData, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}
export function unseal(value: string, encodedKey: string, additionalData?: string): unknown {
  const bytes = Buffer.from(value, 'base64url')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encodedKey, 'base64'),
    bytes.subarray(0, 12)
  )
  if (additionalData !== undefined) decipher.setAAD(Buffer.from(additionalData, 'utf8'))
  decipher.setAuthTag(bytes.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  )
}
export function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a),
    bb = Buffer.from(b)
  return aa.length === bb.length && timingSafeEqual(aa, bb)
}
export function safeReturnPath(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value))
    return '/applications'
  try {
    const target = new URL(value, 'https://bff.invalid')
    if (
      target.origin !== 'https://bff.invalid' ||
      target.pathname === '/' ||
      target.pathname.startsWith('//') ||
      /^\/(auth|api)(\/|$)/i.test(decodeURIComponent(target.pathname))
    )
      return '/applications'
    return `${target.pathname}${target.search}${target.hash}`
  } catch {
    return '/applications'
  }
}

/** Open the configured common login; Auth still validates the client's callback allowlist. */
export function resolveAuthorizationLoginRedirect(
  authorizationUrl: URL,
  expected: string,
  forceLogin = false,
  reason = ''
): string {
  const target = new URL(expected)
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.hash !== '#/auth/oauth-consent'
  )
    throw new Error('统一登录入口配置无效')
  const query = new URLSearchParams({ sso_authorize: authorizationUrl.href })
  if (forceLogin) query.set('sso_force', '1')
  if (
    ['access_denied', 'service_unavailable', 'login_failed', 'authorization_cancelled'].includes(
      reason
    )
  )
    query.set('sso_error', reason)
  // Hash routes do not change the HTML cache key. Use a public cache key so a
  // cached pre-SSO login bundle cannot discard this application's request.
  target.searchParams.set('_auth_ui', Date.now().toString(36))
  target.hash = `#/auth/login?${query}`
  return target.href
}
