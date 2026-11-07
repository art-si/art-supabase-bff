import TreeUtils from '@/utils/tree'
import type { QueryResult } from '@/types/api/response'
import { bffSession, call } from '@bff/api/bff'
import type { ResourceCapabilities } from 'art-supabase-pro/src/api/data-center'
export * from 'art-supabase-pro/src/api/data-center'

/** Standard resource capabilities are scoped to the authenticated BFF session. */
export async function fetchResourceCapabilities(): Promise<ResourceCapabilities> {
  const permissions = bffSession.value?.permissions ?? []
  return {
    canView: permissions.includes('BffResource:View'),
    canUpload: permissions.includes('BffResource:Add'),
    canRename: permissions.includes('BffResource:Edit'),
    canDelete: permissions.includes('BffResource:Delete')
  }
}

type Resource = Api.DataCenter.Resources.ResourceListItem & { version: number }

/** The shared resource workspace reads BFF-owned metadata through the server session. */
export async function fetchResourceList(
  params: Api.DataCenter.Resources.ResourceSearchParams & { tenantId?: string }
) {
  const query = new URLSearchParams({
    from: String(params.from ?? 0),
    to: String(params.to ?? 9),
    originName: params.originName ?? '',
    suffix: params.suffix ?? ''
  })
  const result = await call<{ data: Resource[]; total: number }>(`/api/resources?${query}`)
  return { ...result, error: null }
}

export function renameResource(params: { id: string; originName: string; version?: number }) {
  return call(`/api/resources/${encodeURIComponent(params.id)}/name`, {
    method: 'PUT',
    body: JSON.stringify({ originName: params.originName, version: params.version })
  })
}

export function deleteResource(
  params: Api.DataCenter.Resources.ResourceListItem & { version?: number }
) {
  return call<{ storageCleanupFailed: boolean }>(`/api/resources/${params.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ version: params.version })
  })
}

type Dictionary = Api.DataCenter.DictListItem & { dictTypeTable: { name: string; code: string } }
interface Snapshot {
  revision: number
  types: Api.DataCenter.DictTypeItem[]
  items: Dictionary[]
}
async function snapshot(options = false) {
  const result = await call<Snapshot>(`/api/control/dictionaries${options ? '?options=1' : ''}`)
  return {
    ...result,
    types: result.types.map((row) => ({ ...row, collectionVersion: result.revision })),
    items: result.items.map((row) => ({ ...row, collectionVersion: result.revision }))
  }
}
async function write(
  resource: 'dictionary-types' | 'dictionary-items',
  operation: string,
  definition: Api.DataCenter.DictTypeItem | Api.DataCenter.DictListItem
) {
  const revision =
    definition.collectionVersion ?? (!definition.id ? (await snapshot()).revision : undefined)
  return call(`/api/control/${resource}`, {
    method: 'POST',
    body: JSON.stringify({ operation, definition, revision })
  })
}
export async function fetchDictionaryTypeList(params: Partial<Api.DataCenter.DictTypeItem> = {}) {
  const { types } = await snapshot()
  return {
    data: types.filter((row) => !params.name || row.name.includes(params.name)),
    error: null
  }
}
export async function fetchDictionaryTypeOptions(params: { excludeId?: string } = {}) {
  const { types } = await snapshot(true)
  return {
    data: types.filter((row) => row.nodeType === 'dictionary' && row.id !== params.excludeId),
    error: null
  }
}
export async function fetchDictionaryDirectoryTree(params: { excludeId?: string } = {}) {
  const { types } = await snapshot()
  const utils = new TreeUtils({ parentKey: 'parentId' })
  const tree = utils.listToTree(types.filter((row) => row.nodeType === 'directory'))
  return {
    data: params.excludeId
      ? utils.removeNodesByCondition(tree, (row) => row.id === params.excludeId).tree
      : tree,
    error: null
  }
}
export async function fetchDictionaryListByTypeId(
  params: Partial<Api.DataCenter.DictListItem> & { recordId?: string }
) {
  const { items } = await snapshot()
  const data = items.filter(
    (row) =>
      (!params.typeId || row.typeId === params.typeId) &&
      (!params.recordId || row.id === params.recordId) &&
      (!params.label || row.label?.includes(params.label)) &&
      (!params.code || row.code === params.code) &&
      (!params.i18nScope || row.i18nScope === params.i18nScope) &&
      (!params.status || row.status === params.status)
  )
  return { data, error: null, total: data.length }
}
export async function fetchDictionaryList(): Promise<QueryResult<Dictionary[]>> {
  return { data: (await snapshot(true)).items, error: null }
}
export async function fetchDictionaryListByTypeCode(
  code: string
): Promise<QueryResult<Dictionary[]>> {
  return {
    data: (await snapshot(true)).items.filter((row) => row.dictTypeTable.code === code),
    error: null
  }
}
export async function fetchDictionaryDisplayItem(
  code: string,
  value: string
): Promise<QueryResult<Api.DataCenter.DictListItem[]>> {
  return {
    data: await call<Dictionary[]>(
      `/api/control/dictionary-display?${new URLSearchParams({ code, value })}`
    ),
    error: null
  }
}
export async function fetchDictTypeIdByDictionaryId(id: string) {
  return (await snapshot()).items.find((row) => row.id === id)?.typeId
}
export function addDictType(value: Api.DataCenter.DictTypeItem) {
  return write('dictionary-types', 'create', value)
}
export function editDictType(value: Api.DataCenter.DictTypeItem) {
  return write('dictionary-types', 'update', value)
}
export function addDict(value: Api.DataCenter.DictListItem) {
  return write('dictionary-items', 'create', value)
}
export function editDict(value: Api.DataCenter.DictListItem) {
  return write('dictionary-items', 'update', value)
}
export async function deleteDictType(value: Api.DataCenter.DictTypeItem) {
  return call('/api/control/dictionary-types', {
    method: 'POST',
    body: JSON.stringify({
      operation: 'delete',
      ids: [value.id],
      revision: value.collectionVersion
    })
  })
}
export async function deleteDict(value: Api.DataCenter.DictListItem) {
  return deleteDictBatch(value.id ? [value.id] : [], { collectionVersion: value.collectionVersion })
}
export async function deleteDictBatch(ids: string[], context: { collectionVersion?: number } = {}) {
  return call('/api/control/dictionary-items', {
    method: 'POST',
    body: JSON.stringify({ operation: 'delete', ids, revision: context.collectionVersion })
  })
}
export async function saveDictTypeTreeOrder(
  order: Array<{ id: string; parentId: string | null; sort: number }>,
  context: { collectionVersion?: number } = {}
) {
  return call('/api/control/dictionary-types', {
    method: 'POST',
    body: JSON.stringify({ operation: 'reorder', order, revision: context.collectionVersion })
  })
}
