import { call } from '@bff/api/bff'
import type {
  ReleaseHistory,
  ReleaseList,
  ReleaseListQuery,
  ReleaseOptions,
  ReleaseReadiness
} from '@bff/types/release'

export function fetchReleases(query: ReleaseListQuery): Promise<ReleaseList> {
  const params = new URLSearchParams({ current: String(query.current), size: String(query.size) })
  for (const key of ['name', 'applicationId', 'environment', 'status', 'recordId'] as const) {
    if (query[key]) params.set(key, query[key])
  }
  return call<ReleaseList>(`/api/releases?${params}`)
}

export function fetchReleaseOptions(): Promise<ReleaseOptions> {
  return call<ReleaseOptions>('/api/releases/options')
}

export function fetchReleaseHistory(
  interfaceId: string,
  pages: { versionPage: number; eventPage: number; size: number } = {
    versionPage: 1,
    eventPage: 1,
    size: 20
  }
): Promise<ReleaseHistory> {
  const params = new URLSearchParams({
    versionPage: String(pages.versionPage),
    eventPage: String(pages.eventPage),
    size: String(pages.size)
  })
  return call<ReleaseHistory>(`/api/releases/${encodeURIComponent(interfaceId)}/history?${params}`)
}

export function fetchReleaseReadiness(
  interfaceId: string,
  purpose: 'publish' | 'rollback' | 'enable',
  targetVersionId?: string
): Promise<ReleaseReadiness> {
  const params = new URLSearchParams({ purpose })
  if (targetVersionId) params.set('targetVersionId', targetVersionId)
  return call<ReleaseReadiness>(
    `/api/releases/${encodeURIComponent(interfaceId)}/readiness?${params}`
  )
}

export function publishRelease(
  interfaceId: string,
  input: { draftVersion: number; deploymentVersion: number; notes: string }
): Promise<ReleaseHistory> {
  return call<ReleaseHistory>(`/api/releases/${encodeURIComponent(interfaceId)}/publish`, {
    method: 'POST',
    body: JSON.stringify(input)
  })
}

export function rollbackRelease(
  interfaceId: string,
  input: { targetVersionId: string; deploymentVersion: number; notes: string }
): Promise<ReleaseHistory> {
  return call<ReleaseHistory>(`/api/releases/${encodeURIComponent(interfaceId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify(input)
  })
}

export function changeReleaseStatus(
  interfaceId: string,
  input: { enabled: boolean; deploymentVersion: number; notes: string }
): Promise<ReleaseHistory> {
  return call<ReleaseHistory>(`/api/releases/${encodeURIComponent(interfaceId)}/status`, {
    method: 'POST',
    body: JSON.stringify(input)
  })
}
