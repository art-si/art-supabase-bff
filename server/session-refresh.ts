import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ResponseBodyError } from 'openid-client'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { database } from './database/client'
import { HttpError } from './http'

interface RefreshSession {
  token_hash: string
  payload: string
}
type RefreshState =
  { status: 'claimed' | 'busy' | 'missing' } | { status: 'updated'; payload: string }

const pending = new Map<string, Promise<string>>()

function state(value: unknown): RefreshState {
  if (isObjectRecord(value)) {
    if (value.status === 'updated' && typeof value.payload === 'string' && value.payload)
      return { status: 'updated', payload: value.payload }
    if (value.status === 'claimed' || value.status === 'busy' || value.status === 'missing')
      return { status: value.status }
  }
  throw new HttpError(503, '登录状态暂时无法更新，请稍后重试', 'SESSION_REFRESH_UNAVAILABLE')
}

function expired(): HttpError {
  return new HttpError(401, '登录已过期，请重新登录', 'UNAUTHENTICATED')
}

async function coordinate(row: RefreshSession, exchange: () => Promise<string>): Promise<string> {
  const lease = randomUUID()
  const deadline = performance.now() + 8000
  const parameters = { p_token_hash: row.token_hash, p_payload: row.payload, p_lease: lease }
  let waitMs = 150

  while (performance.now() < deadline) {
    const claimed = await database
      .rpc('bff_session_refresh_claim', parameters)
      .abortSignal(
        AbortSignal.timeout(Math.max(1, Math.min(2500, Math.ceil(deadline - performance.now()))))
      )
    if (claimed.error)
      throw new HttpError(503, '登录状态暂时无法更新，请稍后重试', 'SESSION_REFRESH_UNAVAILABLE', {
        cause: claimed.error
      })
    const current = state(claimed.data)
    if (current.status === 'missing') throw expired()
    if (current.status === 'updated') return current.payload
    if (current.status === 'busy') {
      await delay(Math.min(waitMs, Math.max(1, Math.ceil(deadline - performance.now()))))
      waitMs = Math.min(waitMs * 2, 1000)
      continue
    }

    let next: string | null
    try {
      next = await exchange()
    } catch (error) {
      if (
        !(error instanceof ResponseBodyError) ||
        !['invalid_grant', 'invalid_token'].includes(error.error)
      )
        throw new HttpError(503, '身份中心暂时无法连接，请稍后重试', 'AUTH_SESSION_UNAVAILABLE', {
          cause: error
        })
      next = null
    }
    const finished = await database
      .rpc('bff_session_refresh_finish', { ...parameters, p_next_payload: next })
      .abortSignal(AbortSignal.timeout(8000))
    if (finished.error)
      throw new HttpError(503, '登录状态暂时无法保存，请稍后重试', 'SESSION_REFRESH_UNAVAILABLE', {
        cause: finished.error
      })
    const result = state(finished.data)
    if (result.status === 'missing') throw expired()
    if (result.status === 'updated') return result.payload
    // A timed-out holder cannot overwrite or delete the new holder's session.
    throw new HttpError(503, '登录状态正在更新，请稍后重试', 'SESSION_REFRESH_BUSY')
  }
  throw new HttpError(503, '登录状态正在更新，请稍后重试', 'SESSION_REFRESH_BUSY')
}

/** Coalesce locally, then acquire a database lease shared by every BFF instance. */
export async function refreshSessionPayload(
  row: RefreshSession,
  exchange: () => Promise<string>
): Promise<string> {
  const existing = pending.get(row.token_hash)
  if (existing) return existing
  const task = coordinate(row, exchange)
  pending.set(row.token_hash, task)
  try {
    return await task
  } finally {
    if (pending.get(row.token_hash) === task) pending.delete(row.token_hash)
  }
}
