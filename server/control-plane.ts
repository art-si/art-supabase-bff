import type { IncomingMessage } from 'node:http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { requireMutation, type Session } from './auth'
import { uuid } from './applications'
import { database } from './database/client'
import { body, HttpError } from './http'

export function controlFailure(error: { code?: string; message?: string } | null): void {
  if (!error) return
  const failures: Record<string, [number, string]> = {
    BFF_FORBIDDEN: [403, '当前账号没有此操作权限'],
    BFF_CONFLICT: [409, '记录或层级已被修改，请重新打开后再操作'],
    BFF_NOT_FOUND: [404, '记录不存在，或已不在当前工作空间'],
    BFF_BUILTIN_PROTECTED: [409, '系统预置的访问入口和权限标识需要保留'],
    BFF_REFERENCED: [409, '记录仍被引用，请处理关联记录后重试'],
    BFF_SELF_LOCKOUT: [409, '不能停用自己或降低自己的管理员身份'],
    BFF_LAST_ADMIN: [409, '工作空间至少需要保留一名启用的管理员']
  }
  const known =
    error.message && Object.hasOwn(failures, error.message) ? failures[error.message] : undefined
  if (known) throw new HttpError(known[0], known[1], error.message)
  if (error.message?.startsWith('BFF_INVALID_'))
    throw new HttpError(400, '提交内容格式有误，请检查后重试')
  if (error.code === '23505') throw new HttpError(409, '编码、访问地址或字典值已存在，请检查后重试')
  if (error.code === '23503')
    throw new HttpError(409, '关联记录已变化，或记录仍被引用，请刷新后重试')
  if (['23514', '22P02', '22003', '23502'].includes(error.code || ''))
    throw new HttpError(400, '提交内容或层级关系无效，请检查后重试')
  throw new Error('基础管理操作失败', { cause: error })
}

export function text(value: unknown, label: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `请填写${label}`)
    return ''
  }
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new HttpError(400, `${label}格式有误或超出长度限制`)
  return value.trim()
}
function integer(value: unknown, label: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1000000)
    throw new HttpError(400, `${label}需为有效的非负整数`)
  return value
}
function nullableId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new HttpError(400, '关联记录标识格式有误')
  return uuid(value)
}
export function revisionInput(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new HttpError(400, '缺少有效的版本信息，请刷新后重试')
  return value
}
export function idsInput(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 500)
    throw new HttpError(400, '每次请选择 1–500 条记录')
  const ids = value.map((id: unknown) => {
    if (typeof id !== 'string') throw new HttpError(400, '记录标识格式有误')
    return uuid(id)
  })
  if (new Set(ids).size !== ids.length) throw new HttpError(400, '请选择不重复的记录')
  return ids
}
const menuComponents = new Set([
  '',
  '/index/index',
  '/bff/applications/index',
  '/bff/upstreams/index',
  '/bff/interfaces/index',
  '/shared/system/menu',
  '/shared/system/role',
  '/shared/system/website-config',
  '/bff/system/member/index',
  '/shared/data-center/dict'
])
export function menuInput(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value) || !isObjectRecord(value.meta))
    throw new HttpError(400, '菜单内容格式有误')
  const type = text(value.type, '菜单类型', 10, true)
  if (!['folder', 'menu', 'button'].includes(type)) throw new HttpError(400, '菜单类型无效')
  const name = text(value.name, '权限标识', 120, true)
  if (!/^[A-Za-z][A-Za-z0-9_:-]{0,119}$/.test(name))
    throw new HttpError(400, '权限标识需以字母开头，仅包含字母、数字、冒号、下划线或连字符')
  const component = text(value.component, '组件路径', 200)
  if (!menuComponents.has(component))
    throw new HttpError(400, '组件尚未安装，请使用已接入的页面组件')
  const path = text(value.path, '路由地址', 500)
  if (path && (!/^\/(?!\/)/.test(path) || /[\p{Cc}\s#?\\]/u.test(path)))
    throw new HttpError(400, '路由地址需为以 / 开头的完整站内路径')
  const meta: Record<string, unknown> = { title: text(value.meta.title, '菜单名称', 120, true) }
  for (const key of [
    'keepAlive',
    'isHide',
    'isHideTab',
    'isEnable',
    'isIframe',
    'showBadge',
    'fixedTab',
    'isFullPage'
  ]) {
    const item = value.meta[key]
    if (item !== undefined && typeof item !== 'boolean')
      throw new HttpError(400, '菜单行为设置格式有误')
    if (typeof item === 'boolean') meta[key] = item
  }
  for (const key of ['icon', 'showTextBadge', 'activePath'])
    meta[key] = text(value.meta[key], '菜单展示设置', 200)
  const link = text(value.meta.link, '外部链接', 2000)
  if (link) {
    let url: URL
    try {
      url = new URL(link)
    } catch {
      throw new HttpError(400, '请填写完整的 HTTP 或 HTTPS 外部链接')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new HttpError(400, '请填写完整的 HTTP 或 HTTPS 外部链接')
  }
  meta.link = link
  if (type !== 'button' && !path && !link) throw new HttpError(400, '请填写路由地址或外部链接')
  if (type === 'menu' && !link && !component) throw new HttpError(400, '请选择已接入的页面组件')
  return {
    id: nullableId(value.id),
    parentId: nullableId(value.parentId),
    name,
    type,
    path: type === 'button' ? '' : path,
    component: type === 'button' ? '' : component,
    sort: integer(value.sort, '菜单排序', 1),
    meta,
    ...(value.id ? { version: revisionInput(value.version) } : {})
  }
}
export function dictionaryInput(
  resource: 'type' | 'item',
  value: unknown
): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new HttpError(400, '字典内容格式有误')
  const status = value.status ?? '1'
  if (status !== '1' && status !== '2') throw new HttpError(400, '字典状态无效')
  const base = {
    id: nullableId(value.id),
    parentId: nullableId(value.parentId),
    status,
    sort: integer(value.sort, '字典排序', 0),
    remark: text(value.remark, '备注', 1000),
    ...(value.id ? { version: revisionInput(value.version) } : {})
  }
  if (resource === 'type') {
    if (!['directory', 'dictionary'].includes(String(value.nodeType)))
      throw new HttpError(400, '请选择目录或字典类型')
    const code = text(value.code, '字典编码', 100, value.nodeType === 'dictionary')
    if (value.nodeType === 'dictionary' && !/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(code))
      throw new HttpError(400, '字典编码格式有误')
    return {
      ...base,
      nodeType: value.nodeType,
      name: text(value.name, '节点名称', 100, true),
      code,
      cascadeParentTypeId:
        value.nodeType === 'dictionary' ? nullableId(value.cascadeParentTypeId) : null
    }
  }
  const color = text(value.color, '颜色', 9)
  if (color && !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color))
    throw new HttpError(400, '颜色需为十六进制颜色值')
  const tagType = text(value.tagType, '标签类型', 10)
  if (!['', 'primary', 'success', 'warning', 'info', 'danger'].includes(tagType))
    throw new HttpError(400, '标签类型无效')
  const typeId = nullableId(value.typeId)
  if (!typeId) throw new HttpError(400, '请选择所属字典类型')
  return {
    ...base,
    typeId,
    cascadeParentId: nullableId(value.cascadeParentId),
    label: text(value.label, '字典标签', 120, true),
    value: text(value.value, '字典值', 1000, true),
    code: text(value.code, '字典项编码', 100),
    i18nScope: text(value.i18nScope ?? '1', '国际化范围', 20),
    color,
    tagType
  }
}
function orderInput(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1000) throw new HttpError(400, '排序内容格式有误')
  return value.map((entry: unknown) => {
    if (!isObjectRecord(entry) || !nullableId(entry.id))
      throw new HttpError(400, '排序记录格式有误')
    return {
      id: nullableId(entry.id),
      sort: integer(entry.sort, '排序'),
      ...('parentId' in entry ? { parentId: nullableId(entry.parentId) } : {})
    }
  })
}
export async function readMenus(session: Session, catalog = false): Promise<unknown> {
  const result = await database.rpc('bff_read_menus', {
    p_actor: session.member.id,
    p_catalog: catalog
  })
  controlFailure(result.error)
  return result.data
}
export async function readDictionaries(session: Session, options = false): Promise<unknown> {
  const result = await database.rpc('bff_read_dictionaries', {
    p_actor: session.member.id,
    p_options: options
  })
  controlFailure(result.error)
  return result.data
}
export async function writeControl(
  req: IncomingMessage,
  session: Session,
  resource: 'menus' | 'dictionary-types' | 'dictionary-items'
): Promise<unknown> {
  requireMutation(req, session)
  const input = await body(req, 262144)
  const operation = text(input.operation, '操作类型', 10, true)
  if (!['create', 'update', 'reorder', 'delete'].includes(operation))
    throw new HttpError(400, '操作类型无效')
  const revision = revisionInput(input.revision)
  const payload =
    operation === 'delete'
      ? { ids: idsInput(input.ids) }
      : operation === 'reorder'
        ? { order: orderInput(input.order) }
        : {
            definition:
              resource === 'menus'
                ? menuInput(input.definition)
                : dictionaryInput(
                    resource === 'dictionary-types' ? 'type' : 'item',
                    input.definition
                  ),
            order: resource === 'menus' ? orderInput(input.order ?? []) : []
          }
  const result =
    resource === 'menus'
      ? await database.rpc('bff_write_menu', {
          p_actor: session.member.id,
          p_operation: operation,
          p_payload: payload,
          p_revision: revision
        })
      : await database.rpc('bff_write_dictionary', {
          p_actor: session.member.id,
          p_resource: resource === 'dictionary-types' ? 'type' : 'item',
          p_operation: operation,
          p_payload: payload,
          p_revision: revision
        })
  controlFailure(result.error)
  return result.data
}

export async function controlReferences(req: IncomingMessage, session: Session): Promise<unknown> {
  requireMutation(req, session)
  const input = await body(req, 65536)
  if (input.table === 'bff_upstream_services' || input.table === 'bff_interfaces') {
    const ids = idsInput(input.ids)
    if (ids.length !== 1) throw new HttpError(400, '请逐条检查业务记录的关联')
    const result = await database.rpc(
      input.table === 'bff_interfaces' ? 'bff_interface_references' : 'bff_upstream_references',
      {
        p_actor: session.member.id,
        p_id: ids[0]
      }
    )
    controlFailure(result.error)
    return result.data
  }
  const resource =
    input.resourceType ??
    {
      sys_role: 'role',
      sys_menu: 'menu',
      sys_dict_type: 'dict_type',
      sys_dictionary: 'dictionary'
    }[String(input.table)]
  if (!['role', 'menu', 'dict_type', 'dictionary'].includes(String(resource)))
    throw new HttpError(400, '该资源尚未接入关联检查')
  const result = await database.rpc('bff_control_references', {
    p_actor: session.member.id,
    p_resource: resource,
    p_ids: idsInput(input.ids)
  })
  controlFailure(result.error)
  return result.data
}
export async function uniqueControlField(
  req: IncomingMessage,
  session: Session
): Promise<{ taken: boolean }> {
  requireMutation(req, session)
  const input = await body(req)
  const field = text(input.field, '校验字段', 40, true)
  const value = text(input.value, '校验值', 1000, true)
  const excludeId = nullableId(input.excludeId)
  const scopes: Record<string, { table: string; fields: string[]; permission: string }> = {
    sys_role: { table: 'bff_roles', fields: ['role_code'], permission: 'System:Role:View' },
    sys_menu: { table: 'bff_menus', fields: ['name', 'path'], permission: 'System:Menu:View' },
    sys_dict_type: {
      table: 'bff_dictionary_types',
      fields: ['code'],
      permission: 'DataCenter:Dict:View'
    },
    sys_dictionary: {
      table: 'bff_dictionary_items',
      fields: ['value', 'code'],
      permission: 'DataCenter:Dict:View'
    }
  }
  const scope = Object.hasOwn(scopes, String(input.table)) ? scopes[String(input.table)] : undefined
  if (!scope || !scope.fields.includes(field)) throw new HttpError(400, '校验资源或字段无效')
  const permission = await database.rpc('bff_actor_can', {
    p_actor: session.member.id,
    p_permission: scope.permission
  })
  controlFailure(permission.error)
  if (!permission.data) throw new HttpError(403, '当前账号没有此资源的查看权限')
  let query = database
    .from(scope.table)
    .select('id')
    .eq('tenant_id', session.member.tenant_id)
    .eq(field, value)
    .limit(1)
  if (excludeId) query = query.neq('id', excludeId)
  if (scope.table === 'bff_dictionary_types') query = query.eq('node_type', 'dictionary')
  if (scope.table === 'bff_dictionary_items' && isObjectRecord(input.extraWhere)) {
    const typeId = nullableId(input.extraWhere.type_id ?? input.extraWhere.typeId)
    if (typeId) query = query.eq('type_id', typeId)
  }
  const result = await query
  controlFailure(result.error)
  return { taken: Boolean(result.data?.length) }
}
export async function dictionaryDisplay(session: Session, url: URL): Promise<unknown> {
  const code = text(url.searchParams.get('code'), '字典编码', 100, true)
  const value = text(url.searchParams.get('value'), '字典值', 1000, true)
  // Exact historical lookup only; disabled values never join normal options.
  const result = await database
    .from('bff_dictionary_items')
    .select(
      'id,type_id,label,value,code,status,sort,color,tag_type,remark,parent_id,cascade_parent_id,bff_dictionary_types!inner(code)'
    )
    .eq('tenant_id', session.member.tenant_id)
    .eq('bff_dictionary_types.code', code)
    .eq('value', value)
    .limit(1)
  controlFailure(result.error)
  return (result.data ?? []).map((row) => ({
    id: row.id,
    typeId: row.type_id,
    label: row.label,
    value: row.value,
    code: row.code,
    status: row.status,
    sort: row.sort,
    color: row.color,
    tagType: row.tag_type,
    remark: row.remark,
    parentId: row.parent_id,
    cascadeParentId: row.cascade_parent_id
  }))
}

export async function tableColumnRuntime(session: Session, url: URL): Promise<unknown> {
  const routes: Record<string, string> = {
    '/system/menu': 'System:Menu:View',
    '/system/role': 'System:Role:View',
    '/system/member': 'System:Member:View',
    '/data-center/dict': 'DataCenter:Dict:View',
    '/applications': 'BffApplication:View',
    '/upstreams': 'BffUpstream:View',
    '/interfaces': 'BffInterface:View'
  }
  const routePath = url.searchParams.get('routePath') || ''
  const permission = Object.hasOwn(routes, routePath) ? routes[routePath] : undefined
  if (!permission) throw new HttpError(404, '当前页面未配置列方案')
  const result = await database.rpc('bff_actor_can', {
    p_actor: session.member.id,
    p_permission: permission
  })
  controlFailure(result.error)
  if (!result.data) throw new HttpError(403, '当前账号没有此页面的查看权限')
  // BFF currently uses the canonical frontend columns. Pro's tenant profiles
  // belong to pro and must never be queried using BFF's server session.
  return { enabled: false, catalog: null, profiles: [] }
}
