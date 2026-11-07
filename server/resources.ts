import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { MIMEType } from 'node:util'
import { uniq } from 'lodash-es'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'
import { mapWithConcurrency } from 'art-supabase-pro/src/utils/async.ts'
import {
  RESOURCE_MIME_SUFFIXES,
  type BffResource,
  type BffResourceList,
  type BffResourceReference
} from '../src/types/resource'
import { requireMutation, type Session } from './auth'
import { text } from './control-plane'
import { database } from './database/client'
import { body, HttpError } from './http'
import { uuid } from './applications'

const bucket = 'bff-assets'
const maxFileBytes = 10 * 1024 * 1024
const maxMultipartBytes = maxFileBytes + 64 * 1024
const tokenPattern = /^[0-9a-f]{64}$/
const safeInline = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/x-icon',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm'
])
const suffixes = new Set(Object.values(RESOURCE_MIME_SUFFIXES).flat())
const textTypes: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json'
}

export function isResourceObjectKey(value: unknown, tenantId?: string): value is string {
  if (typeof value !== 'string') return false
  const segments = value.split('/')
  if (segments.length !== 2) return false
  const filenameParts = segments[1].split('.')
  if (filenameParts.length !== 2 || !suffixes.has(filenameParts[1])) return false
  try {
    uuid(segments[0])
    uuid(filenameParts[0])
  } catch {
    return false
  }
  return !tenantId || segments[0] === tenantId
}

function failure(error: { code?: string; message?: string } | null): void {
  if (!error) return
  const messages: Record<string, [number, string]> = {
    BFF_FORBIDDEN: [403, '当前账号没有此资源的操作权限'],
    BFF_NOT_FOUND: [404, '资源不存在，或已不在当前工作空间'],
    BFF_CONFLICT: [409, '资源已变化，请刷新列表后重试'],
    BFF_REFERENCED: [409, '资源仍被系统品牌或业务记录使用，请先替换引用'],
    BFF_RESOURCE_STATE: [409, '资源状态已变化，请刷新后重试'],
    BFF_RESOURCE_NOT_READY: [409, '资源尚未上传完成，请稍后重试'],
    BFF_RESOURCE_RESERVATION_EXPIRED: [409, '上传确认已过期，请重新上传'],
    BFF_RESOURCE_CLEANUP_LEASE: [409, '资源清理任务正在处理，请稍后刷新']
  }
  const known = error.message ? messages[error.message] : undefined
  if (known) throw new HttpError(known[0], known[1], error.message)
  if (error.message?.startsWith('BFF_INVALID_'))
    throw new HttpError(400, '资源参数格式有误，请检查后重试')
  throw new Error('资源服务暂不可用', { cause: error })
}
function object(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new Error('Invalid resource response')
  return value
}
function string(value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid resource text')
  return value
}
function optionalString(value: unknown, max = 500): string | null {
  return value === null || value === undefined ? null : string(value, max)
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('Invalid resource number')
  return value
}
function id(value: unknown): number {
  const parsed = typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1)
    throw new HttpError(400, '资源标识格式有误')
  return parsed
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new HttpError(400, '资源版本缺失，请刷新列表后重试')
  return value
}
function filename(value: unknown): string {
  const name = text(value, '文件名', 200, true)
  if (
    /[\\/]/.test(name) ||
    [...name].some((part) => part.charCodeAt(0) < 32 || part.charCodeAt(0) === 127) ||
    name === '.' ||
    name === '..'
  )
    throw new HttpError(400, '文件名包含不支持的字符')
  return name
}
function claim(
  value: unknown,
  kind: 'upload' | 'cleanup',
  tenantId?: string
): { id: number; objectKey: string; token: string } {
  const row = object(value)
  const claimToken = row[kind === 'upload' ? 'uploadToken' : 'cleanupToken']
  if (row.storageBucket !== bucket) throw new Error('Invalid resource storage claim: bucket')
  if (!isResourceObjectKey(row.objectKey, tenantId))
    throw new Error('Invalid resource storage claim: key')
  if (typeof claimToken !== 'string' || !tokenPattern.test(claimToken))
    throw new Error('Invalid resource storage claim: token')
  return { id: integer(row.id, 1), objectKey: row.objectKey, token: claimToken }
}
export function resourceDto(value: unknown, tenantId?: string): BffResource {
  const row = object(value)
  const resourceId = integer(row.id, 1)
  const mimeType = string(row.mimeType, 150)
  const suffix = string(row.suffix, 10)
  if (!RESOURCE_MIME_SUFFIXES[mimeType]?.includes(suffix)) throw new Error('Invalid resource type')
  const url = string(row.url, 150)
  if (url !== `/api/resources/${resourceId}/content`) throw new Error('Invalid resource URL')
  const resourceTenantId = string(row.tenantId, 36)
  if (tenantId && resourceTenantId !== tenantId) throw new Error('Invalid resource tenant')
  return {
    id: resourceId,
    tenantId: resourceTenantId,
    originName: string(row.originName, 200),
    mimeType,
    suffix,
    sizeByte: integer(row.sizeByte, 1, maxFileBytes),
    sizeInfo: string(row.sizeInfo, 50),
    url,
    version: integer(row.version, 1),
    createdAt: string(row.createdAt, 40),
    updatedAt: string(row.updatedAt, 40)
  }
}
function resourceRow(value: unknown, tenantId: string): BffResourceList {
  const row = object(value)
  if (!Array.isArray(row.data) || row.data.length > 100) throw new Error('Invalid resource list')
  const data = row.data.map((item: unknown) => resourceDto(item, tenantId))
  const total = integer(row.total)
  if (total < data.length) throw new Error('Invalid resource total')
  return { data, total }
}
export async function listResources(session: Session, url: URL): Promise<BffResourceList> {
  const from = Number(url.searchParams.get('from') || 0)
  const to = Number(url.searchParams.get('to') || 29)
  if (
    !Number.isSafeInteger(from) ||
    from < 0 ||
    from > 100000 ||
    !Number.isSafeInteger(to) ||
    to < from ||
    to - from >= 100
  )
    throw new HttpError(400, '分页范围无效')
  const name = text(url.searchParams.get('originName'), '文件名称', 100)
  const rawSuffixes = url.searchParams.get('suffix')?.split(',').filter(Boolean) ?? []
  if (rawSuffixes.length > 10 || rawSuffixes.some((item) => !/^[a-z0-9]{1,10}$/.test(item)))
    throw new HttpError(400, '文件类型筛选无效')
  const result = await database.rpc(
    'bff_read_resources',
    {
      p_actor: session.member.id,
      p_from: from,
      p_to: to,
      p_name: name,
      p_suffixes: rawSuffixes
    },
    { get: true }
  )
  failure(result.error)
  return resourceRow(result.data, session.member.tenant_id)
}
export async function parseResourceUpload(
  req: IncomingMessage
): Promise<{ name: string; data: Buffer; mime: string; suffix: string }> {
  const header = req.headers['content-type']
  let contentType: MIMEType
  try {
    contentType = new MIMEType(header || '')
  } catch {
    throw new HttpError(415, '请使用文件上传格式提交')
  }
  const boundary = contentType.params.get('boundary')
  if (contentType.essence !== 'multipart/form-data' || !boundary || boundary.length > 70)
    throw new HttpError(415, '请使用文件上传格式提交')
  const announced = Number(req.headers['content-length'] || 0)
  if (announced > maxMultipartBytes) throw new HttpError(413, '上传文件不能超过 10 MiB')
  const chunks: Buffer[] = []
  let received = 0
  for await (const part of req) {
    const bytes = typeof part === 'string' ? Buffer.from(part) : Buffer.from(part)
    received += bytes.length
    if (received > maxMultipartBytes) throw new HttpError(413, '上传文件不能超过 10 MiB')
    chunks.push(bytes)
  }
  let form: FormData
  try {
    form = await new Request('http://localhost/upload', {
      method: 'POST',
      headers: { 'Content-Type': header },
      body: Buffer.concat(chunks, received)
    }).formData()
  } catch {
    throw new HttpError(400, '上传文件格式无效')
  }
  const entries = [...form.entries()]
  if (entries.length !== 1 || entries[0][0] !== 'file' || !(entries[0][1] instanceof File))
    throw new HttpError(400, '每次只能上传一个文件')
  const file = entries[0][1]
  const name = filename(file.name)
  const suffix = name.split('.').at(-1)?.toLowerCase() ?? ''
  if (!suffixes.has(suffix)) throw new HttpError(400, '不支持此文件类型')
  if (file.size < 1 || file.size > maxFileBytes)
    throw new HttpError(413, '上传文件需为 1 字节至 10 MiB')
  const data = Buffer.from(await file.arrayBuffer())
  const mime = await detectResourceMime(data, suffix)
  if (!mime) throw new HttpError(400, '文件内容与扩展名不一致，或文件类型不受支持')
  return { name, data, mime, suffix }
}
export async function detectResourceMime(data: Buffer, suffix: string): Promise<string | null> {
  if (Object.hasOwn(textTypes, suffix)) {
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(data)
    } catch {
      return null
    }
    if (
      [...content].some((part) => {
        const code = part.charCodeAt(0)
        return code === 0 || (code < 32 && code !== 9 && code !== 10 && code !== 13)
      })
    )
      return null
    if (suffix === 'json') {
      try {
        JSON.parse(content)
      } catch {
        return null
      }
    }
    return textTypes[suffix]
  }
  // Binary parsers are needed only for uploads, so they do not delay auth/server startup.
  const { fileTypeFromBuffer } = await import('file-type')
  const detected = await fileTypeFromBuffer(data)
  if (!detected) return null
  const aliases: Record<string, string> = {
    'image/vnd.microsoft.icon': 'image/x-icon',
    'audio/x-wav': 'audio/wav',
    'audio/ogg; codecs=opus': 'audio/ogg',
    'application/ogg': 'audio/ogg',
    'video/ogg': 'audio/ogg',
    'audio/webm': 'video/webm'
  }
  const mime = aliases[detected.mime] ?? detected.mime
  if (mime === 'application/x-cfb' && ['doc', 'xls', 'ppt'].includes(suffix)) {
    const legacyOfficeMime: Record<string, string> = {
      doc: 'application/msword',
      xls: 'application/vnd.ms-excel',
      ppt: 'application/vnd.ms-powerpoint'
    }
    return legacyOfficeMime[suffix] ?? null
  }
  return RESOURCE_MIME_SUFFIXES[mime]?.includes(suffix) ? mime : null
}
export async function uploadResource(req: IncomingMessage, session: Session): Promise<BffResource> {
  let stage = 'authorize'
  try {
    requireMutation(req, session)
    const allowed = await database.rpc(
      'bff_actor_can',
      { p_actor: session.member.id, p_permission: 'BffResource:Add' },
      { get: true }
    )
    failure(allowed.error)
    if (allowed.data !== true) throw new HttpError(403, '当前账号没有上传资源的权限')
    stage = 'parse'
    const file = await parseResourceUpload(req)
    const hash = createHash('sha256').update(file.data).digest('hex')
    stage = 'reserve'
    const reserved = await database.rpc('bff_resource_reserve', {
      p_actor: session.member.id,
      p_name: file.name,
      p_mime: file.mime,
      p_suffix: file.suffix,
      p_size: file.data.length,
      p_hash: hash
    })
    failure(reserved.error)
    stage = 'claim'
    const uploaded = claim(reserved.data, 'upload', session.member.tenant_id)
    stage = 'storage'
    const storage = await database.storage.from(bucket).upload(uploaded.objectKey, file.data, {
      contentType: file.mime,
      upsert: false,
      cacheControl: '3600'
    })
    if (storage.error) throw new Error('资源上传失败', { cause: storage.error })
    stage = 'complete'
    const complete = await database.rpc('bff_resource_complete', {
      p_actor: session.member.id,
      p_id: uploaded.id,
      p_token: uploaded.token
    })
    failure(complete.error)
    return resourceDto(complete.data, session.member.tenant_id)
  } catch (error) {
    if (!(error instanceof HttpError)) {
      const cause = error instanceof Error ? error.cause : null
      const code =
        isObjectRecord(cause) &&
        typeof cause.code === 'string' &&
        /^[A-Za-z0-9_]{1,30}$/.test(cause.code)
          ? cause.code
          : 'UNKNOWN'
      console.error('[BFF] 资源上传失败', {
        stage,
        kind: error instanceof Error ? error.name : 'UnknownError',
        check:
          error instanceof Error && error.message.startsWith('Invalid resource storage claim:')
            ? error.message.slice('Invalid resource storage claim:'.length).trim()
            : undefined,
        code
      })
    }
    throw error
  }
}
export async function renameResource(
  req: IncomingMessage,
  session: Session,
  resourceId: string
): Promise<BffResource> {
  requireMutation(req, session)
  const input = await body(req)
  const result = await database.rpc('bff_rename_resource', {
    p_actor: session.member.id,
    p_id: id(resourceId),
    p_version: version(input.version),
    p_name: filename(input.originName)
  })
  failure(result.error)
  return resourceDto(result.data, session.member.tenant_id)
}
export async function resourceReferences(
  req: IncomingMessage,
  session: Session
): Promise<BffResourceReference[]> {
  requireMutation(req, session)
  const input = await body(req)
  if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 50)
    throw new HttpError(400, '每次请选择 1–50 条资源')
  const ids = uniq(input.ids.map(id))
  const result = await database.rpc('bff_resource_references', {
    p_actor: session.member.id,
    p_ids: ids
  })
  failure(result.error)
  if (!Array.isArray(result.data) || result.data.length > 100)
    throw new Error('Invalid resource references')
  return result.data.map((item: unknown) => {
    const row = object(item)
    const resourceId = integer(row.resourceId, 1)
    if (
      !ids.includes(resourceId) ||
      row.targetId !== resourceId ||
      row.recordId !== session.member.tenant_id ||
      (row.dependencyCode !== 'logoUrl' && row.dependencyCode !== 'faviconUrl') ||
      row.cleanupAllowed !== false
    )
      throw new Error('Invalid resource reference')
    return {
      resourceId: String(resourceId),
      dependencyCode: row.dependencyCode,
      recordId: string(row.recordId, 100),
      targetId: String(resourceId),
      recordNo: string(row.recordNo, 200),
      recordSummary: optionalString(row.recordSummary, 500),
      recordStatus: null,
      recordAmount: null,
      createdAt: string(row.createdAt, 40),
      cleanupAllowed: false
    }
  })
}
export async function deleteResource(
  req: IncomingMessage,
  session: Session,
  resourceId: string
): Promise<{ storageCleanupFailed: boolean }> {
  requireMutation(req, session)
  const input = await body(req)
  const begun = await database.rpc('bff_resource_delete_begin', {
    p_actor: session.member.id,
    p_id: id(resourceId),
    p_version: version(input.version)
  })
  failure(begun.error)
  const deletion = claim(begun.data, 'cleanup', session.member.tenant_id)
  const removed = await database.storage.from(bucket).remove([deletion.objectKey])
  if (removed.error && !objectAbsent(removed.error)) return { storageCleanupFailed: true }
  const finished = await database.rpc('bff_resource_cleanup_finish', {
    p_id: deletion.id,
    p_token: deletion.token
  })
  if (finished.error || !isObjectRecord(finished.data) || finished.data.deleted !== true)
    return { storageCleanupFailed: true }
  return { storageCleanupFailed: false }
}
export async function resourceDisplayNames(
  session: Session,
  url: URL
): Promise<Record<string, string>> {
  const raw = url.searchParams.get('ids')
  if (!raw) return {}
  const parts = raw.split(',')
  if (parts.length > 50) throw new HttpError(400, '每次最多查询 50 个资源名称')
  const ids = uniq(parts.map(id))
  const result = await database.rpc(
    'bff_resource_names',
    { p_actor: session.member.id, p_ids: ids },
    { get: true }
  )
  failure(result.error)
  if (!Array.isArray(result.data) || result.data.length > ids.length)
    throw new Error('Invalid resource names')
  return Object.fromEntries(
    result.data.map((item: unknown) => {
      const row = object(item)
      const resourceId = integer(row.id, 1)
      if (!ids.includes(resourceId)) throw new Error('Invalid resource name scope')
      const key = String(resourceId)
      return [key, string(row.originName, 200)]
    })
  )
}
export async function serveResource(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  resourceId: string
): Promise<void> {
  if (req.method !== 'GET') throw new HttpError(405, '资源请求方式无效')
  const result = await database.rpc(
    'bff_resource_content',
    { p_actor: session.member.id, p_id: id(resourceId) },
    { get: true }
  )
  failure(result.error)
  const row = object(result.data)
  const resource = claimContent(row, session.member.tenant_id)
  const downloaded = await database.storage.from(bucket).download(resource.objectKey)
  if (downloaded.error || !downloaded.data) throw new HttpError(503, '资源暂时无法读取，请稍后重试')
  if (downloaded.data.size !== resource.sizeByte)
    throw new HttpError(503, '资源内容尚未就绪，请稍后重试')
  const filename = encodeURIComponent(resource.originName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
  res.writeHead(200, {
    'Content-Type': resource.mimeType,
    'Content-Length': resource.sizeByte,
    'Content-Disposition': `${safeInline.has(resource.mimeType) ? 'inline' : 'attachment'}; filename="resource.${resource.suffix}"; filename*=UTF-8''${filename}`,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, no-store'
  })
  Readable.fromWeb(downloaded.data.stream())
    .on('error', () => res.destroy())
    .pipe(res)
}
function claimContent(
  value: Record<string, unknown>,
  tenantId: string
): { objectKey: string; mimeType: string; sizeByte: number; originName: string; suffix: string } {
  const mimeType = string(value.mimeType, 150)
  if (!RESOURCE_MIME_SUFFIXES[mimeType]) throw new Error('Invalid content type')
  const objectKey = string(value.objectKey, 150)
  if (value.storageBucket !== bucket || !isResourceObjectKey(objectKey, tenantId))
    throw new Error('Invalid resource content claim')
  const suffix = objectKey.split('.').at(-1)!
  if (!RESOURCE_MIME_SUFFIXES[mimeType].includes(suffix))
    throw new Error('Invalid resource content extension')
  return {
    objectKey,
    mimeType,
    sizeByte: integer(value.sizeByte, 1, maxFileBytes),
    originName: filename(value.originName),
    suffix
  }
}

let cleanupRunning = false
let failures = 0
let nextCleanupAt = 0
export async function runResourceCleanup(): Promise<void> {
  if (cleanupRunning || Date.now() < nextCleanupAt) return
  cleanupRunning = true
  try {
    const claimed = await database.rpc('bff_resource_cleanup_claim', { p_limit: 5 })
    failure(claimed.error)
    if (!Array.isArray(claimed.data) || claimed.data.length > 5)
      throw new Error('Invalid cleanup batch')
    const outcomes = await mapWithConcurrency(
      claimed.data,
      3,
      async (item: unknown): Promise<boolean> => {
        const resource = claim(item, 'cleanup')
        const removed = await database.storage.from(bucket).remove([resource.objectKey])
        if (removed.error && !objectAbsent(removed.error)) return false
        const finished = await database.rpc('bff_resource_cleanup_finish', {
          p_id: resource.id,
          p_token: resource.token
        })
        return !finished.error && isObjectRecord(finished.data) && finished.data.deleted === true
      }
    )
    if (outcomes.some((outcome) => !outcome)) throw new Error('RESOURCE_CLEANUP_FAILED')
    if (failures) console.info('[BFF] 资源清理已恢复')
    failures = 0
    nextCleanupAt = 0
  } catch (error) {
    failures += 1
    nextCleanupAt = Date.now() + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 4))
    if (failures === 1)
      console.warn('[BFF] 资源清理暂不可用，将自动降频重试', {
        code: error instanceof HttpError ? error.code : 'RESOURCE_CLEANUP_FAILED'
      })
  } finally {
    cleanupRunning = false
  }
}
function objectAbsent(error: unknown): boolean {
  if (!isObjectRecord(error)) return false
  return (
    error.statusCode === '404' ||
    error.statusCode === 404 ||
    error.status === 404 ||
    error.code === 'not_found' ||
    error.code === 'NoSuchKey'
  )
}
export function startResourceCleanup(): () => void {
  const timer = setInterval(() => {
    void runResourceCleanup()
  }, 60_000)
  timer.unref()
  return () => clearInterval(timer)
}
