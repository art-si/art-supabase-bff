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
export function seal(value: unknown, encodedKey: string): string {
  const key = Buffer.from(encodedKey, 'base64')
  if (key.length !== 32) throw new Error('BFF_SESSION_KEY 必须为 32 字节的 Base64 编码')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}
export function unseal(value: string, encodedKey: string): unknown {
  const bytes = Buffer.from(value, 'base64url')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encodedKey, 'base64'),
    bytes.subarray(0, 12)
  )
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

/** Accept only the configured consent UI and an opaque Auth-server request ID. */
export function resolveAuthorizationUiRedirect(location: string, expected: string): string {
  const target = new URL(location)
  const allowed = new URL(expected)
  const [route, query = ''] = target.hash.split('?')
  const requestId = new URLSearchParams(query).get('authorization_id')
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.origin !== allowed.origin ||
    target.pathname !== allowed.pathname ||
    target.search !== allowed.search ||
    route !== allowed.hash ||
    !requestId ||
    !/^[A-Za-z0-9_-]{1,512}$/.test(requestId)
  )
    throw new Error('统一授权入口返回了无效地址')
  return target.href
}

/** Preserve the validated Auth request while opening the unified login form. */
export function resolveAuthorizationLoginRedirect(
  location: string,
  expected: string,
  forceLogin = false,
  reason = ''
): string {
  const target = new URL(resolveAuthorizationUiRedirect(location, expected))
  const authorizationId = new URLSearchParams(target.hash.split('?')[1]).get('authorization_id')!
  const resume = new URLSearchParams({ sso_authorization_id: authorizationId })
  const query = new URLSearchParams({
    sso_authorization_id: authorizationId,
    redirect: `/auth/login?${resume}`
  })
  if (forceLogin) query.set('sso_force', '1')
  if (reason === 'access_denied') query.set('sso_error', reason)
  target.hash = `#/auth/login?${query}`
  return target.href
}
