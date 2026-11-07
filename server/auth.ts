import type { IncomingMessage, ServerResponse } from 'node:http'
import * as oidc from 'openid-client'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { config, authReady } from './config'
import { oidcIdentityFetch } from './identity-http'
import { database, requireData } from './database/client'
import { cookie, setCookie, redirect, HttpError } from './http'
import {
  digest,
  opaqueToken,
  resolveAuthorizationLoginRedirect,
  safeEqual,
  safeReturnPath,
  seal,
  unseal
} from './security'

export interface Member {
  id: string
  issuer: string
  subject: string
  tenant_id: string
  display_name: string
  email: string
  role: 'admin' | 'viewer'
  enabled: boolean
}
interface LoginTransaction {
  verifier: string
  returnTo: string
}
interface StoredLoginTransaction {
  state_hash: string
  browser_hash: string
  payload: string
  expires_at: string
}

/** One ambiguous save can be replayed with the exact same key, ciphertext and expiry. */
export async function saveLoginTransaction(transaction: StoredLoginTransaction): Promise<void> {
  const save = () =>
    database
      .from('bff_auth_transactions')
      .upsert(transaction, { onConflict: 'state_hash' })
      .select('state_hash')
      .abortSignal(AbortSignal.timeout(8000))
      .single()
  let result = await save()
  if (result.error && (result.status === 0 || result.status === 408 || result.status >= 500))
    result = await save()
  const stored: unknown = requireData(result)
  if (!isObjectRecord(stored) || stored.state_hash !== transaction.state_hash)
    throw new HttpError(503, '登录请求暂时无法保存，请重新发起登录')
}
interface Tokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subject: string
}
interface SessionRow {
  token_hash: string
  member_id: string
  payload: string
  csrf_token: string
  expires_at: string
}
export interface Session {
  row: SessionRow
  member: Member
  tokens: Tokens
}
let provider: Promise<oidc.Configuration> | undefined
function getProvider(): Promise<oidc.Configuration> {
  if (!authReady())
    throw new HttpError(503, '统一登录尚未配置完成，请联系平台管理员', 'AUTH_NOT_CONFIGURED')
  provider ??= oidc
    .discovery(
      new URL(config.issuer),
      config.clientId,
      config.clientSecret || undefined,
      undefined,
      { [oidc.customFetch]: oidcIdentityFetch }
    )
    .catch((error) => {
      provider = undefined
      throw error
    })
  return provider
}
function parseTokens(value: unknown): Tokens {
  if (
    !value ||
    typeof value !== 'object' ||
    !('accessToken' in value) ||
    !('refreshToken' in value) ||
    !('subject' in value) ||
    !('expiresAt' in value) ||
    typeof value.accessToken !== 'string' ||
    typeof value.refreshToken !== 'string' ||
    typeof value.subject !== 'string' ||
    typeof value.expiresAt !== 'number'
  )
    throw new HttpError(401, '登录已失效，请重新登录')
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    subject: value.subject,
    expiresAt: value.expiresAt
  }
}

export async function startLogin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const forceLogin = url.searchParams.get('force_login') === '1'
  const restart = url.searchParams.get('restart') === '1'
  if (!forceLogin && !restart) {
    try {
      await authenticate(req)
      redirect(res, safeReturnPath(url.searchParams.get('returnTo')))
      return
    } catch (error) {
      if (!(error instanceof HttpError) || ![401, 503].includes(error.status)) throw error
    }
  }
  if (!authReady())
    throw new HttpError(503, '统一登录尚未配置完成，请联系平台管理员', 'AUTH_NOT_CONFIGURED')
  const verifier = oidc.randomPKCECodeVerifier(),
    state = oidc.randomState(),
    browser = opaqueToken()
  const transaction: LoginTransaction = {
    verifier,
    returnTo: safeReturnPath(url.searchParams.get('returnTo'))
  }
  const authorizationUrl = new URL(`${config.issuer.replace(/\/$/, '')}/oauth/authorize`)
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: `${config.origin}/api/auth/callback`,
    // UserInfo supports the existing pro HS256 signer without requesting an ID token.
    scope: 'email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state
  }).toString()
  const reason = url.searchParams.get('reason') || ''
  if (reason === 'service_unavailable') {
    redirect(
      res,
      resolveAuthorizationLoginRedirect(authorizationUrl, config.authorizationUi, true, reason)
    )
    return
  }
  try {
    await saveLoginTransaction({
      state_hash: digest(state),
      browser_hash: digest(browser),
      payload: seal(transaction, config.sessionKey),
      expires_at: new Date(Date.now() + 600000).toISOString()
    })
  } catch (error) {
    console.error('[bff] OAuth start failed', {
      stage: 'AUTH_TRANSACTION_SAVE',
      kind: error instanceof Error ? error.name : 'UnknownError'
    })
    res.setHeader('X-BFF-Auth-Error', 'AUTH_TRANSACTION_SAVE')
    redirect(
      res,
      resolveAuthorizationLoginRedirect(
        authorizationUrl,
        config.authorizationUi,
        true,
        'service_unavailable'
      )
    )
    return
  }
  setCookie(res, 'bff_login', browser, 600)
  redirect(
    res,
    resolveAuthorizationLoginRedirect(authorizationUrl, config.authorizationUi, forceLogin, reason)
  )
}

export async function finishLogin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const state = url.searchParams.get('state'),
    browser = cookie(req, 'bff_login')
  if (!state || !browser) throw new HttpError(400, '登录请求已失效，请重新开始登录')
  // DELETE ... RETURNING consumes a matching browser-bound transaction exactly once.
  const result = await database
    .from('bff_auth_transactions')
    .delete()
    .eq('state_hash', digest(state))
    .eq('browser_hash', digest(browser))
    .gt('expires_at', new Date().toISOString())
    .select('payload')
    .maybeSingle()
  if (result.error) throw new Error('登录事务读取失败', { cause: result.error })
  if (!result.data) throw new HttpError(400, '登录请求已失效，请重新开始登录')
  setCookie(res, 'bff_login', '', 0)
  const value = unseal(result.data.payload, config.sessionKey)
  if (
    !value ||
    typeof value !== 'object' ||
    !('verifier' in value) ||
    !('returnTo' in value) ||
    typeof value.verifier !== 'string' ||
    typeof value.returnTo !== 'string'
  )
    throw new HttpError(400, '登录请求已失效')
  const settings = await getProvider()
  const tokens = await oidc.authorizationCodeGrant(settings, url, {
    pkceCodeVerifier: value.verifier,
    expectedState: state
  })
  // No ID token is requested. The code is client-bound and browser-bound; Auth's
  // authenticated UserInfo endpoint is the authority for the stable subject.
  const profile = await oidc.fetchUserInfo(settings, tokens.access_token, oidc.skipSubjectCheck)
  const lookup = await database
    .from('bff_members')
    .select('*')
    .eq('issuer', config.issuer)
    .eq('subject', profile.sub)
    .maybeSingle()
  if (lookup.error) throw new Error('成员信息读取失败', { cause: lookup.error })
  const member = lookup.data as Member | null
  if (!member?.enabled)
    throw new HttpError(403, '该账号尚未开通 BFF 平台访问权限，请联系管理员', 'ACCESS_NOT_GRANTED')
  const token = opaqueToken()
  const payload: Tokens = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || '',
    expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    subject: profile.sub
  }
  requireData(
    await database
      .from('bff_sessions')
      .insert({
        token_hash: digest(token),
        member_id: member.id,
        payload: seal(payload, config.sessionKey),
        csrf_token: opaqueToken(),
        expires_at: new Date(Date.now() + 604800000).toISOString()
      })
      .select('token_hash')
      .single()
  )
  const previous = cookie(req, 'bff_session')
  if (previous) await database.from('bff_sessions').delete().eq('token_hash', digest(previous))
  setCookie(res, 'bff_session', token, 604800)
  redirect(res, safeReturnPath(value.returnTo))
}

const refreshes = new Map<string, Promise<Tokens>>()
async function refresh(row: SessionRow, tokens: Tokens): Promise<Tokens> {
  const existing = refreshes.get(row.token_hash)
  if (existing) return existing
  const task = (async () => {
    if (!tokens.refreshToken) throw new HttpError(401, '登录已过期，请重新登录')
    const settings = await getProvider()
    const updated = await oidc.refreshTokenGrant(settings, tokens.refreshToken)
    await oidc.fetchUserInfo(settings, updated.access_token, tokens.subject)
    const next: Tokens = {
      ...tokens,
      accessToken: updated.access_token,
      refreshToken: updated.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + (updated.expires_in || 3600) * 1000
    }
    requireData(
      await database
        .from('bff_sessions')
        .update({ payload: seal(next, config.sessionKey) })
        .eq('token_hash', row.token_hash)
        .select('token_hash')
        .single()
    )
    return next
  })()
  refreshes.set(row.token_hash, task)
  try {
    return await task
  } catch (error) {
    if (
      error instanceof oidc.ResponseBodyError &&
      ['invalid_grant', 'invalid_token'].includes(error.error)
    ) {
      const result = await database.from('bff_sessions').delete().eq('token_hash', row.token_hash)
      if (result.error)
        throw new AggregateError([error, result.error], '会话失效处理失败', { cause: error })
      throw new HttpError(401, '登录已过期，请重新登录', 'UNAUTHENTICATED', { cause: error })
    }
    if (error instanceof HttpError) throw error
    throw new HttpError(503, '身份中心暂时无法连接，请重新登录', 'AUTH_SESSION_UNAVAILABLE', {
      cause: error
    })
  } finally {
    refreshes.delete(row.token_hash)
  }
}

export function sessionSnapshot(value: unknown): { row: SessionRow; member: Member } {
  if (
    !isObjectRecord(value) ||
    typeof value.token_hash !== 'string' ||
    typeof value.member_id !== 'string' ||
    typeof value.payload !== 'string' ||
    typeof value.csrf_token !== 'string' ||
    typeof value.expires_at !== 'string'
  )
    throw new HttpError(503, '登录状态暂时无法读取，请稍后重试')
  const member = value.member
  if (!isObjectRecord(member) || member.enabled !== true || member.issuer !== config.issuer)
    throw new HttpError(403, '平台访问权限已停用', 'ACCESS_NOT_GRANTED')
  if (
    member.id !== value.member_id ||
    typeof member.id !== 'string' ||
    typeof member.subject !== 'string' ||
    typeof member.tenant_id !== 'string' ||
    typeof member.display_name !== 'string' ||
    typeof member.email !== 'string' ||
    (member.role !== 'admin' && member.role !== 'viewer')
  )
    throw new HttpError(503, '平台访问权限暂时无法读取，请稍后重试')
  return {
    row: {
      token_hash: value.token_hash,
      member_id: value.member_id,
      payload: value.payload,
      csrf_token: value.csrf_token,
      expires_at: value.expires_at
    },
    member: {
      id: member.id,
      issuer: config.issuer,
      subject: member.subject,
      tenant_id: member.tenant_id,
      display_name: member.display_name,
      email: member.email,
      role: member.role,
      enabled: true
    }
  }
}
export async function authenticate(req: IncomingMessage): Promise<Session> {
  const token = cookie(req, 'bff_session')
  if (!token) throw new HttpError(401, '请先登录', 'UNAUTHENTICATED')
  const sessionResult = await database
    .from('bff_sessions')
    .select(
      'token_hash,member_id,payload,csrf_token,expires_at,member:bff_members(id,issuer,subject,tenant_id,display_name,email,role,enabled)'
    )
    .eq('token_hash', digest(token))
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (sessionResult.error)
    throw new HttpError(503, '登录状态暂时无法读取，请重新登录', 'SESSION_UNAVAILABLE', {
      cause: sessionResult.error
    })
  if (!sessionResult.data) throw new HttpError(401, '登录已过期，请重新登录', 'UNAUTHENTICATED')
  const { row, member } = sessionSnapshot(sessionResult.data)
  let tokens = parseTokens(unseal(row.payload, config.sessionKey))
  if (tokens.subject !== member.subject) throw new HttpError(401, '登录身份不匹配')
  if (tokens.expiresAt < Date.now() + 60000) tokens = await refresh(row, tokens)
  return { row, member, tokens }
}
export function requireMutation(
  req: Pick<IncomingMessage, 'headers'>,
  session: Pick<Session, 'row'>
): void {
  if (
    req.headers.origin !== config.origin ||
    !safeEqual(String(req.headers['x-csrf-token'] || ''), session.row.csrf_token)
  )
    throw new HttpError(403, '请求校验失败，请刷新页面后重试')
}
export function requireAdmin(member: Member): void {
  if (member.role !== 'admin') throw new HttpError(403, '当前账号没有管理权限')
}
export async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.headers.origin !== config.origin) throw new HttpError(403, '请求校验失败，请刷新后重试')
  const token = cookie(req, 'bff_session')
  if (token) {
    const lookup = await database
      .from('bff_sessions')
      .select('*')
      .eq('token_hash', digest(token))
      .maybeSingle()
    if (lookup.error) throw new Error('退出登录失败', { cause: lookup.error })
    const row = lookup.data as SessionRow | null
    if (row) {
      requireMutation(req, { row })
      const result = await database.from('bff_sessions').delete().eq('token_hash', row.token_hash)
      if (result.error) throw new Error('退出登录失败', { cause: result.error })
    }
  }
  setCookie(res, 'bff_session', '', 0)
}
