import { call } from '@bff/api/bff'
import type {
  UpstreamCreateInput,
  UpstreamCredentialInput,
  UpstreamList,
  UpstreamListQuery,
  UpstreamOptions,
  UpstreamService,
  UpstreamStatus,
  UpstreamUpdateInput
} from '@bff/types/upstream'

export function fetchUpstreams(query: UpstreamListQuery): Promise<UpstreamList> {
  const params = new URLSearchParams({ current: String(query.current), size: String(query.size) })
  for (const key of ['applicationId', 'name', 'environment', 'status', 'recordId'] as const) {
    if (query[key]) params.set(key, query[key])
  }
  return call<UpstreamList>(`/api/upstreams?${params}`)
}

export function fetchUpstreamOptions(): Promise<UpstreamOptions> {
  return call<UpstreamOptions>('/api/upstreams/options')
}

export function createUpstream(input: UpstreamCreateInput): Promise<UpstreamService> {
  return call<UpstreamService>('/api/upstreams', { method: 'POST', body: JSON.stringify(input) })
}

export function updateUpstream(id: string, input: UpstreamUpdateInput): Promise<UpstreamService> {
  return call<UpstreamService>(`/api/upstreams/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  })
}

export function changeUpstreamCredential(
  id: string,
  input: UpstreamCredentialInput
): Promise<UpstreamService> {
  return call<UpstreamService>(`/api/upstreams/${encodeURIComponent(id)}/credential`, {
    method: 'PUT',
    body: JSON.stringify(input)
  })
}

export function changeUpstreamStatus(
  id: string,
  version: number,
  status: Extract<UpstreamStatus, 'active' | 'disabled'>
): Promise<UpstreamService> {
  return call<UpstreamService>(`/api/upstreams/${encodeURIComponent(id)}/status`, {
    method: 'POST',
    body: JSON.stringify({ version, status })
  })
}

export function testUpstreamHealth(id: string, version: number): Promise<UpstreamService> {
  return call<UpstreamService>(`/api/upstreams/${encodeURIComponent(id)}/health-tests`, {
    method: 'POST',
    body: JSON.stringify({ version })
  })
}

export function deleteUpstream(id: string, version: number): Promise<void> {
  return call<void>(`/api/upstreams/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ version })
  })
}
