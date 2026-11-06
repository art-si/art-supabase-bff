import type { AppRouteRecord } from '@/types/router'
import { toNextDayStartUTC, toStartOfDayUTC } from '@/utils/time/format'
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
  const snapshot = await call<MenuSnapshot>('/api/control/menus?catalog=1')
  return { data: snapshot.records, revision: snapshot.revision, error: null }
}

interface RoleSnapshot {
  revision: number
  records: Api.SystemManage.RoleListItem[]
}
async function roles() {
  const snapshot = await call<RoleSnapshot>('/api/control/roles')
  return {
    ...snapshot,
    records: snapshot.records.map((row) => ({ ...row, collectionVersion: snapshot.revision }))
  }
}
export async function fetchRoleList(params: Api.SystemManage.RoleSearchParams) {
  const snapshot = await roles()
  const start = toStartOfDayUTC(params.startTime || '')
  const end = toNextDayStartUTC(params.endTime || '')
  const records = snapshot.records.filter(
    (row) =>
      (!params.recordId || row.id === params.recordId) &&
      (!params.roleName || row.roleName.includes(params.roleName)) &&
      (!params.roleCode || row.roleCode === params.roleCode) &&
      (!params.description || row.description?.includes(params.description)) &&
      (typeof params.enabled !== 'boolean' || row.enabled === params.enabled) &&
      (!start || Date.parse(row.createTime || '') >= Date.parse(start)) &&
      (!end || Date.parse(row.createTime || '') < Date.parse(end))
  )
  return {
    data: records.slice(params.from ?? 0, (params.to ?? 9) + 1),
    count: records.length,
    error: null
  }
}
export async function addRole(params: Api.SystemManage.RoleListItem) {
  await call('/api/control/roles', {
    method: 'POST',
    body: JSON.stringify({
      operation: 'create',
      revision: (await roles()).revision,
      definition: params
    })
  })
  return { error: null }
}
export async function editRole(params: Api.SystemManage.RoleListItem) {
  await call('/api/control/roles', {
    method: 'POST',
    body: JSON.stringify({
      operation: 'update',
      revision: params.collectionVersion,
      definition: params
    })
  })
  return { error: null }
}
export async function deleteRole(params: Api.SystemManage.RoleListItem) {
  await call('/api/control/roles', {
    method: 'POST',
    body: JSON.stringify({
      operation: 'delete',
      id: params.id,
      version: params.version,
      revision: params.collectionVersion
    })
  })
  return { error: null }
}
export async function getCurrentRoleMenus(params: { id: string }) {
  const result = await call<{
    records: { menuId: string }[]
    revision: number
    menuRevision: number
    roleVersion: number
  }>(`/api/control/roles/${params.id}/menus`)
  return {
    data: result.records,
    revision: result.revision,
    menuRevision: result.menuRevision,
    roleVersion: result.roleVersion,
    error: null
  }
}
export async function saveRoleMenuList(params: {
  p_role_id: string
  p_menu_ids: string[]
  expectedMenuIds?: string[]
  revision?: number
  menuRevision?: number
  roleVersion?: number
}) {
  await call(`/api/control/roles/${params.p_role_id}/menus`, {
    method: 'POST',
    body: JSON.stringify({
      ids: params.p_menu_ids,
      expectedIds: params.expectedMenuIds,
      revision: params.revision,
      menuRevision: params.menuRevision,
      roleVersion: params.roleVersion
    })
  })
  return { error: null }
}
export async function fetchRoleUsers(roleId: string) {
  return {
    data: await call<{
      records: import('art-supabase-pro/src/api/system-manage').RoleUserRecord[]
    }>(`/api/control/roles/${roleId}/users`),
    error: null
  }
}
export async function saveRoleUsers(params: {
  roleId: string
  userIds: string[]
  expectedUserIds: string[]
}) {
  await call(`/api/control/roles/${params.roleId}/users`, {
    method: 'POST',
    body: JSON.stringify({ ids: params.userIds, expectedIds: params.expectedUserIds })
  })
  return { error: null }
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
