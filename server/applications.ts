import type { IncomingMessage } from 'node:http'
import { database, requireData } from './database/client'
import { requireAdmin, requireMutation, type Session } from './auth'
import { body, HttpError } from './http'

export function applicationInput(value: Record<string, unknown>): {
  code: string
  name: string
  description: string
  homeUrl: string
  enabled: boolean
  version: number | null
} {
  if (typeof value.code !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(value.code))
    throw new HttpError(400, '应用编码需为 2–64 位小写字母、数字或连字符，并以字母开头')
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 100)
    throw new HttpError(400, '请填写 100 字以内的应用名称')
  if (typeof value.description !== 'string' || value.description.length > 1000)
    throw new HttpError(400, '应用说明不能超过 1000 字')
  if (typeof value.homeUrl !== 'string' || value.homeUrl.length > 2000)
    throw new HttpError(400, '应用地址格式有误')
  if (value.homeUrl) {
    let url: URL
    try {
      url = new URL(value.homeUrl)
    } catch {
      throw new HttpError(400, '请输入完整的 HTTP 或 HTTPS 应用地址')
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new HttpError(400, '请输入完整的 HTTP 或 HTTPS 应用地址')
  }
  if (typeof value.enabled !== 'boolean') throw new HttpError(400, '应用状态格式有误')
  const version =
    typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 0
      ? value.version
      : null
  return {
    code: value.code,
    name: value.name.trim(),
    description: value.description.trim(),
    homeUrl: value.homeUrl.trim(),
    enabled: value.enabled,
    version
  }
}
export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new HttpError(400, '记录标识格式有误')
  return value
}
function rpcFailure(error: { code?: string; message?: string } | null): void {
  if (!error) return
  if (error.code === '23505') throw new HttpError(409, '该应用编码已存在，请更换编码')
  if (error.message === 'BFF_CONFLICT') throw new HttpError(409, '应用已被其他人修改，请刷新后重试')
  if (error.message === 'BFF_FORBIDDEN') throw new HttpError(403, '没有操作该应用或成员的权限')
  throw new Error('应用保存失败', { cause: error })
}
export async function listApplications(session: Session, url: URL): Promise<unknown> {
  const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('current')) || 1))
  const size = Math.max(1, Math.min(100, Number(url.searchParams.get('size')) || 20))
  let query = database
    .from('bff_applications')
    .select('id,code,name,description,home_url,enabled,version,created_at,updated_at', {
      count: 'exact'
    })
    .eq('tenant_id', session.member.tenant_id)
  if (session.member.role !== 'admin') {
    const grants = requireData(
      await database
        .from('bff_application_members')
        .select('application_id')
        .eq('member_id', session.member.id)
    )
    if (!grants.length) return { records: [], total: 0, current: page, size }
    query = query
      .in(
        'id',
        grants.map((row) => row.application_id)
      )
      .eq('enabled', true)
  }
  const keyword = url.searchParams.get('name')?.trim().slice(0, 100)
  if (keyword) query = query.ilike('name', `%${keyword.replace(/[%_\\]/g, '\\$&')}%`)
  const result = await query
    .order('created_at', { ascending: false })
    .range((page - 1) * size, page * size - 1)
  const rows = requireData(result)
  return {
    records: rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      version: row.version,
      homeUrl: row.home_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    total: result.count || 0,
    current: page,
    size
  }
}
export async function saveApplication(
  req: IncomingMessage,
  session: Session,
  id?: string
): Promise<unknown> {
  requireMutation(req, session)
  requireAdmin(session.member)
  const input = applicationInput(await body(req))
  if (id && !input.version) throw new HttpError(400, '请刷新后重试')
  const result = await database.rpc('bff_save_application', {
    p_actor: session.member.id,
    p_id: id ? uuid(id) : null,
    p_version: input.version,
    p_code: input.code,
    p_name: input.name,
    p_description: input.description,
    p_home_url: input.homeUrl,
    p_enabled: input.enabled
  })
  rpcFailure(result.error)
  return { saved: true }
}
export async function listApplicationMembers(
  session: Session,
  applicationId: string
): Promise<unknown> {
  requireAdmin(session.member)
  const app = await database
    .from('bff_applications')
    .select('id')
    .eq('id', uuid(applicationId))
    .eq('tenant_id', session.member.tenant_id)
    .maybeSingle()
  if (app.error) throw new Error('应用读取失败', { cause: app.error })
  if (!app.data) throw new HttpError(404, '应用不存在')
  const members = requireData(
    await database
      .from('bff_members')
      .select('id,display_name,email,role,enabled')
      .eq('tenant_id', session.member.tenant_id)
      .order('created_at')
  )
  const grants = requireData(
    await database
      .from('bff_application_members')
      .select('member_id')
      .eq('application_id', applicationId)
  )
  return members.map((member) => ({
    id: member.id,
    name: member.display_name,
    email: member.email,
    role: member.role,
    enabled: member.enabled,
    granted: grants.some((grant) => grant.member_id === member.id)
  }))
}
export async function grantApplicationMember(
  req: IncomingMessage,
  session: Session,
  applicationId: string,
  memberId: string
): Promise<unknown> {
  requireMutation(req, session)
  requireAdmin(session.member)
  const input = await body(req)
  if (typeof input.granted !== 'boolean') throw new HttpError(400, '授权状态格式有误')
  const result = await database.rpc('bff_set_application_member', {
    p_actor: session.member.id,
    p_application: uuid(applicationId),
    p_member: uuid(memberId),
    p_granted: input.granted
  })
  rpcFailure(result.error)
  return { saved: true }
}
