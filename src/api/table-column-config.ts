import type { TableColumnRuntime } from '@/types/table-column-config'
import { call } from '@bff/api/bff'
export * from 'art-supabase-pro/src/api/table-column-config'

export function fetchTableColumnRuntime(routePath: string): Promise<TableColumnRuntime> {
  return call(`/api/control/table-columns?${new URLSearchParams({ routePath })}`)
}
