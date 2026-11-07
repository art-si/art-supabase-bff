import type { IncomingMessage } from 'node:http'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { requireMutation, type Session } from './auth'
import { uuid } from './applications'
import { database } from './database/client'
import { body, HttpError } from './http'
import { controlFailure, idsInput, revisionInput, text } from './control-plane'

function selection(value: unknown): string[] {
  if (Array.isArray(value) && value.length === 0) return []
  return idsInput(value)
}
function definition(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new HttpError(400, '角色内容格式有误')
  if (
    value.organizationId !== undefined &&
    value.organizationId !== null &&
    value.organizationId !== ''
  )
    throw new HttpError(400, '当前工作空间尚无可分配的组织')
  const roleCode = text(value.roleCode, '角色编码', 100, true)
  if (!/^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(roleCode))
    throw new HttpError(400, '角色编码需以字母开头，仅包含字母、数字、冒号、下划线或连字符')
  if (typeof value.enabled !== 'boolean') throw new HttpError(400, '请选择角色状态')
  return {
    ...(value.id ? { id: uuid(String(value.id)), version: revisionInput(value.version) } : {}),
    roleCode,
    roleName: text(value.roleName, '角色名称', 100, true),
    description: text(value.description, '角色说明', 1000),
    enabled: value.enabled
  }
}
export async function readRoles(session: Session): Promise<unknown> {
  const result = await database.rpc('bff_read_roles', { p_actor: session.member.id })
  controlFailure(result.error)
  return result.data
}
export async function writeRole(req: IncomingMessage, session: Session): Promise<unknown> {
  requireMutation(req, session)
  const input = await body(req)
  if (!['create', 'update', 'delete'].includes(String(input.operation)))
    throw new HttpError(400, '角色操作无效')
  const result = await database.rpc('bff_write_role', {
    p_actor: session.member.id,
    p_operation: input.operation,
    p_revision: revisionInput(input.revision),
    p_payload:
      input.operation === 'delete'
        ? { id: uuid(String(input.id)), version: revisionInput(input.version) }
        : { definition: definition(input.definition) }
  })
  controlFailure(result.error)
  return result.data
}
export async function roleAssignments(
  req: IncomingMessage,
  session: Session,
  roleId: string,
  resource: 'menus' | 'users'
): Promise<unknown> {
  const role = uuid(roleId)
  if (req.method === 'GET') {
    const result = await database.rpc(
      resource === 'menus' ? 'bff_read_role_menus' : 'bff_read_role_users',
      {
        p_actor: session.member.id,
        p_role: role
      }
    )
    controlFailure(result.error)
    return result.data
  }
  requireMutation(req, session)
  const input = await body(req, 262144)
  const args = {
    p_actor: session.member.id,
    p_role: role,
    p_ids: selection(input.ids),
    p_expected: selection(input.expectedIds)
  }
  const result =
    resource === 'menus'
      ? await database.rpc('bff_set_role_menus', {
          ...args,
          p_revision: revisionInput(input.revision),
          p_menu_revision: revisionInput(input.menuRevision),
          p_role_version: revisionInput(input.roleVersion)
        })
      : await database.rpc('bff_set_role_users', args)
  controlFailure(result.error)
  return result.data
}
export async function readMembers(session: Session): Promise<unknown> {
  const result = await database.rpc('bff_read_members', { p_actor: session.member.id })
  controlFailure(result.error)
  return result.data
}
export async function writeMember(req: IncomingMessage, session: Session): Promise<unknown> {
  requireMutation(req, session)
  const input = await body(req)
  if (input.operation !== 'update' || !isObjectRecord(input.definition))
    throw new HttpError(400, '成员操作内容无效')
  const row = input.definition
  if (typeof row.enabled !== 'boolean' || !['admin', 'viewer'].includes(String(row.role)))
    throw new HttpError(400, '请选择成员状态和基础身份')
  const result = await database.rpc('bff_write_member', {
    p_actor: session.member.id,
    p_revision: revisionInput(input.revision),
    p_definition: {
      id: uuid(String(row.id)),
      version: revisionInput(row.version),
      enabled: row.enabled,
      role: row.role
    }
  })
  controlFailure(result.error)
  return result.data
}
