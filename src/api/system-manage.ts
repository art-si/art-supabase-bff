import type { AppRouteRecord } from '@/types/router'
import { call } from '@bff/api/bff'
export * from 'art-supabase-pro/src/api/system-manage'

interface MenuSnapshot {
  revision: number
  records: AppRouteRecord[]
}
interface WriteResult {
  revision: number
}
async function menus(catalog = false, signal?: AbortSignal) {
  const snapshot = await call<MenuSnapshot>(`/api/control/menus${catalog ? '?catalog=1' : ''}`, {
    signal
  })
  return snapshot.records.map((row) => ({
    ...row,
    collectionVersion: snapshot.revision,
    hasChildren: snapshot.records.some((child) => child.parentId === row.id)
  }))
}
export async function fetchMenuList(
  params: { name?: string; path?: string; recordId?: string },
  signal?: AbortSignal
) {
  const rows = await menus(false, signal)
  const filtered = rows.filter((row) =>
    params.recordId
      ? row.id === params.recordId
      : params.name || params.path
        ? (!params.name || row.meta.title.includes(params.name)) &&
          (!params.path || row.path.includes(params.path))
        : !row.parentId
  )
  return { data: filtered, error: null }
}
export async function fetchMenuChildren(parentId: string) {
  return { data: (await menus()).filter((row) => row.parentId === parentId), error: null }
}
export async function fetchAllMenuList() {
  return { data: await menus(), error: null }
}
export async function fetchMenuCatalog() {
  return { data: await menus(true), error: null }
}
export async function saveMenuDefinition(
  params: AppRouteRecord,
  order: Array<{ id: string; sort: number }>,
  context: { version?: number; collectionVersion?: number } = {}
) {
  const revision =
    context.collectionVersion ??
    (!params.id ? (await call<MenuSnapshot>('/api/control/menus')).revision : undefined)
  await call<WriteResult>('/api/control/menus', {
    method: 'POST',
    body: JSON.stringify({
      operation: params.id ? 'update' : 'create',
      revision,
      definition: { ...params, version: context.version },
      order
    })
  })
}
export async function saveMenuTreeOrder(
  order: Array<{ id: string; parentId: string | null; sort: number }>,
  context: { collectionVersion?: number } = {}
) {
  const result = await call<WriteResult>('/api/control/menus', {
    method: 'POST',
    body: JSON.stringify({ operation: 'reorder', revision: context.collectionVersion, order })
  })
  return { collectionVersion: result.revision }
}
export async function deleteMenu(params: { ids: string[]; collectionVersion?: number }) {
  return call('/api/control/menus', {
    method: 'POST',
    body: JSON.stringify({
      operation: 'delete',
      ids: params.ids,
      revision: params.collectionVersion
    })
  })
}
