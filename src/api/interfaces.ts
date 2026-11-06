import { call } from '@bff/api/bff'
import type {
  InterfaceList,
  InterfaceListQuery,
  InterfaceOptions,
  InterfaceRecord,
  InterfaceScalar,
  InterfaceTestResult,
  InterfaceWriteInput
} from '@bff/types/interface'

export function fetchInterfaces(query: InterfaceListQuery): Promise<InterfaceList> {
  const params = new URLSearchParams({ current: String(query.current), size: String(query.size) })
  for (const key of [
    'name',
    'applicationId',
    'environment',
    'validationStatus',
    'recordId'
  ] as const) {
    if (query[key]) params.set(key, query[key])
  }
  return call<InterfaceList>(`/api/interfaces?${params}`)
}

export function fetchInterfaceOptions(): Promise<InterfaceOptions> {
  return call<InterfaceOptions>('/api/interfaces/options')
}

export function createInterface(input: InterfaceWriteInput): Promise<InterfaceRecord> {
  return call<InterfaceRecord>('/api/interfaces', { method: 'POST', body: JSON.stringify(input) })
}

export function updateInterface(id: string, input: InterfaceWriteInput): Promise<InterfaceRecord> {
  return call<InterfaceRecord>(`/api/interfaces/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  })
}

export function validateInterface(id: string, version: number): Promise<InterfaceRecord> {
  return call<InterfaceRecord>(`/api/interfaces/${encodeURIComponent(id)}/validate`, {
    method: 'POST',
    body: JSON.stringify({ version })
  })
}

export function testInterface(
  id: string,
  version: number,
  input: Record<string, InterfaceScalar>
): Promise<InterfaceTestResult> {
  return call<InterfaceTestResult>(`/api/interfaces/${encodeURIComponent(id)}/tests`, {
    method: 'POST',
    body: JSON.stringify({ version, input })
  })
}

export function deleteInterface(id: string, version: number): Promise<{ saved: true }> {
  return call<{ saved: true }>(`/api/interfaces/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ version })
  })
}
