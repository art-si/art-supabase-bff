import type { IncomingMessage } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { requireMutation, type Session } from './auth'
import { config } from './config'
import { database } from './database/client'
import { remoteFetch } from './remote-http'
import { body, HttpError } from './http'
import { controlFailure, revisionInput, text } from './control-plane'
import { uuid } from './applications'

/** Read identity from pro; write membership exclusively to the BFF database. */
export async function provisionMember(req: IncomingMessage, session: Session): Promise<unknown> {
  requireMutation(req, session)
  const permission = await database.rpc('bff_actor_can', {
    p_actor: session.member.id,
    p_permission: 'System:Member:Add'
  })
  controlFailure(permission.error)
  if (session.member.role !== 'admin' || permission.data !== true)
    throw new HttpError(403, '只有当前租户的平台管理员可以开通成员')
  const input = await body(req, 4096)
  const email = text(input.email, '统一账号邮箱', 254, true).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[*]/.test(email))
    throw new HttpError(400, '请输入完整的统一账号邮箱')
  const revision = revisionInput(input.revision)
  if (!config.identityDirectoryKey)
    throw new HttpError(503, '账号核验服务尚未配置，请联系部署管理员')
  const identity = createClient(new URL(config.issuer).origin, config.identityDirectoryKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: remoteFetch }
  })
  const result = await identity
    .from('sys_user')
    .select('auth_user_id,tenant_id,nick_name,user_name,user_email,status')
    .is('deleted_at', null)
    .ilike('user_email', email.replace(/[\\%_]/g, '\\$&'))
    .limit(2)
    .abortSignal(AbortSignal.timeout(8000))
  if (result.error) throw new HttpError(503, '账号核验暂时不可用，请稍后重试')
  const records: unknown = result.data
  if (!Array.isArray(records) || records.length !== 1 || !isObjectRecord(records[0]))
    throw new HttpError(400, '未找到唯一的有效统一账号，请核对邮箱')
  const user = records[0]
  if (
    user.status !== '1' ||
    typeof user.auth_user_id !== 'string' ||
    typeof user.tenant_id !== 'string'
  )
    throw new HttpError(400, '该统一账号未启用或尚未完成身份绑定')
  const saved = await database.rpc('bff_provision_member', {
    p_actor: session.member.id,
    p_revision: revision,
    p_identity: {
      issuer: config.issuer,
      subject: uuid(user.auth_user_id),
      tenantId: session.member.tenant_id,
      identityTenantId: uuid(user.tenant_id),
      email: text(user.user_email, '邮箱', 254, true),
      displayName: text(user.nick_name || user.user_name, '姓名', 200)
    }
  })
  controlFailure(saved.error)
  return saved.data
}
