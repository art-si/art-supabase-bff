/** Import the packaged Art brand images through the normal BFF upload/publish handlers. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import type { Session } from '../server/auth'
import { config } from '../server/config'
import { database } from '../server/database/client'
import { readBranding, writeBranding } from '../server/branding'
import { isResourceObjectKey, uploadResource } from '../server/resources'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import type { BffBrandingRecord } from '../src/types/branding'

assert.equal(new URL(config.databaseUrl).hostname, 'bksbwnxdurmuolygiofh.supabase.co')
const sessions = await database
  .from('bff_sessions')
  .select('member_id')
  .gt('expires_at', new Date().toISOString())
if (sessions.error) throw new Error('读取当前工作空间会话失败', { cause: sessions.error })
const memberIds = [...new Set(sessions.data.map((row) => row.member_id))]
assert.ok(memberIds.length, '请先通过浏览器登录 BFF')
const members = await database
  .from('bff_members')
  .select('id,issuer,subject,tenant_id,display_name,email,role,enabled')
  .in('id', memberIds)
  .eq('enabled', true)
  .eq('role', 'admin')
if (members.error) throw new Error('读取工作空间管理员失败', { cause: members.error })
assert.equal(members.data.length, 1, '存在多个已登录管理员，请明确目标工作空间后再导入')
const member = members.data[0]
assert.ok(member.role === 'admin')
const session: Session = {
  member: { ...member, role: 'admin' },
  row: {
    token_hash: '',
    member_id: member.id,
    payload: '',
    csrf_token: 'brand-import-local',
    expires_at: new Date(Date.now() + 60000).toISOString()
  },
  tokens: { accessToken: '', refreshToken: '', subject: member.subject, expiresAt: 0 }
}
function request(bytes: Buffer, contentType: string): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.headers = {
    origin: config.origin,
    'x-csrf-token': session.row.csrf_token,
    'content-type': contentType,
    'content-length': String(bytes.length)
  }
  req.push(bytes)
  req.push(null)
  return req
}
const before = await readBranding(session)
async function verify(record: BffBrandingRecord): Promise<void> {
  for (const [url, source] of [
    [record.config.logoUrl, 'art-supabase-pro/src/assets/images/common/logo.webp'],
    [record.config.faviconUrl, 'art-supabase-pro/src/assets/images/favicon.ico']
  ]) {
    const match = /^\/api\/resources\/(\d+)\/content$/.exec(url || '')
    assert.ok(match, '品牌图片未使用资源管理地址')
    const result = await database.rpc('bff_resource_content', {
      p_actor: member.id,
      p_id: Number(match[1])
    })
    if (result.error) throw new Error('当前工作空间无法读取品牌资源', { cause: result.error })
    const content: unknown = result.data
    assert.ok(isObjectRecord(content) && typeof content.objectKey === 'string')
    assert.ok(isResourceObjectKey(content.objectKey, member.tenant_id))
    const downloaded = await fetch(
      new URL(
        `/storage/v1/object/authenticated/bff-assets/${content.objectKey}`,
        config.databaseUrl
      ),
      {
        headers: { Authorization: `Bearer ${config.databaseKey}`, apikey: config.databaseKey },
        signal: AbortSignal.timeout(30000)
      }
    )
    assert.equal(downloaded.status, 200, '读取已上传品牌图片失败')
    assert.deepEqual(
      Buffer.from(await downloaded.arrayBuffer()),
      readFileSync(new URL(import.meta.resolve(source)))
    )
  }
}
if (process.argv.includes('--verify-only')) {
  await verify(before)
  console.log(
    JSON.stringify({
      logoUrl: before.config.logoUrl,
      faviconUrl: before.config.faviconUrl,
      version: before.version,
      verified: true
    })
  )
  process.exit(0)
}
mkdirSync('.artifacts/database', { recursive: true })
const backup = `.artifacts/database/brand-default-import-${Date.now()}.json`
writeFileSync(backup, JSON.stringify({ project: 'bksbwnxdurmuolygiofh', before }, null, 2))
const uploaded = []
for (const entry of [
  {
    name: 'BFF平台 Logo.webp',
    path: 'art-supabase-pro/src/assets/images/common/logo.webp',
    mime: 'image/webp'
  },
  {
    name: 'BFF平台 Favicon.ico',
    path: 'art-supabase-pro/src/assets/images/favicon.ico',
    mime: 'image/x-icon'
  }
]) {
  const bytes = readFileSync(new URL(import.meta.resolve(entry.path)))
  const form = new FormData()
  form.set('file', new File([bytes], entry.name, { type: entry.mime }))
  const transport = new Request('http://localhost/upload', { method: 'POST', body: form })
  const resource = await uploadResource(
    request(Buffer.from(await transport.arrayBuffer()), transport.headers.get('content-type')!),
    session
  )
  uploaded.push(resource)
  writeFileSync(
    backup,
    JSON.stringify({ project: 'bksbwnxdurmuolygiofh', before, uploaded }, null, 2)
  )
}
const saved = await writeBranding(
  request(
    Buffer.from(
      JSON.stringify({
        version: before.version,
        config: { ...before.config, logoUrl: uploaded[0].url, faviconUrl: uploaded[1].url }
      })
    ),
    'application/json'
  ),
  session
)
assert.equal(saved.config.logoUrl, uploaded[0].url)
assert.equal(saved.config.faviconUrl, uploaded[1].url)
await verify(saved)
console.log(
  JSON.stringify({
    logoUrl: saved.config.logoUrl,
    faviconUrl: saved.config.faviconUrl,
    version: saved.version,
    resourcesUploaded: uploaded.length
  })
)
