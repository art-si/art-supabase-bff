import { shallowRef } from 'vue'
import type {
  ApplicationInput,
  ApplicationList,
  ApplicationMember,
  BffSession
} from '@bff/types/bff'

export const bffSession = shallowRef<BffSession | null>(null)
export class BffApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}
export async function call<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(bffSession.value ? { 'X-CSRF-Token': bffSession.value.csrfToken } : {}),
      ...options.headers
    }
  })
  const value = await response.json()
  if (!response.ok) {
    if (response.status === 401) bffSession.value = null
    throw new BffApiError(
      typeof value.message === 'string' ? value.message : '操作失败，请稍后重试',
      response.status
    )
  }
  return value as T
}
export async function loadSession(): Promise<BffSession | null> {
  try {
    bffSession.value = await call<BffSession>('/api/auth/session')
    return bffSession.value
  } catch (error) {
    if (error instanceof BffApiError && error.status === 401) return null
    throw error
  }
}
export async function signOut(): Promise<void> {
  await call('/api/auth/logout', { method: 'POST', body: '{}' })
  bffSession.value = null
}
export async function getAuthStatus(): Promise<{ authenticationConfigured: boolean }> {
  return call('/api/health')
}
export function fetchApplications(query: {
  current: number
  size: number
  name: string
}): Promise<ApplicationList> {
  return call(
    `/api/applications?${new URLSearchParams({ current: String(query.current), size: String(query.size), name: query.name })}`
  )
}
export function saveApplication(input: ApplicationInput, id?: string): Promise<unknown> {
  return call(id ? `/api/applications/${id}` : '/api/applications', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(input)
  })
}
export function fetchApplicationMembers(id: string): Promise<ApplicationMember[]> {
  return call(`/api/applications/${id}/members`)
}
export function setApplicationMember(
  applicationId: string,
  memberId: string,
  granted: boolean
): Promise<unknown> {
  return call(`/api/applications/${applicationId}/members/${memberId}`, {
    method: 'PUT',
    body: JSON.stringify({ granted })
  })
}
