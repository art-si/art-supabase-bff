import { call, BffApiError, bffSession } from './bff'
import type { BffResource } from '../types/resource'

const resourceUrl = /^\/api\/resources\/(\d+)\/content$/

/** Pro's upload control ABI, backed only by the authenticated BFF resource service. */
export async function uploadAttachment(
  files: File | File[],
  options: {
    bucket?: string
    targetTenantId?: string
    createBy?: string
    remark?: string
    concurrency?: number
    onProgress?: (progress: Api.DataCenter.Resources.UploadProgress) => void
  } = {}
): Promise<BffResource[]> {
  if (options.bucket && options.bucket !== 'bff-assets' && options.bucket !== 'attachments')
    throw new BffApiError('该存储位置不可用于 BFF 资源上传', 400)
  if (options.targetTenantId && options.targetTenantId !== bffSession.value?.user.tenantId)
    throw new BffApiError('资源目标空间与当前登录空间不一致', 403)
  const selected = Array.isArray(files) ? files : [files]
  if (!selected.length || selected.length > 20) throw new BffApiError('每次请选择 1–20 个文件', 400)
  const uploaded: BffResource[] = []
  const report = (phase: Api.DataCenter.Resources.UploadPhase, name?: string): void => {
    options.onProgress?.({
      phase,
      processed: uploaded.length,
      succeeded: uploaded.length,
      failed: 0,
      total: selected.length,
      currentFileName: name
    })
  }
  report('preparing')
  try {
    for (const file of selected) {
      if (file.size > 10 * 1024 * 1024) throw new BffApiError('单个文件不能超过 10 MiB', 413)
      const form = new FormData()
      form.set('file', file, file.name)
      report('uploading', file.name)
      const resource = await call<BffResource>('/api/resources/upload', {
        method: 'POST',
        body: form
      })
      uploaded.push(resource)
      report(uploaded.length === selected.length ? 'completed' : 'processing', file.name)
    }
    return uploaded
  } catch (error) {
    options.onProgress?.({
      phase: 'failed',
      processed: uploaded.length,
      succeeded: uploaded.length,
      failed: selected.length - uploaded.length,
      total: selected.length
    })
    throw error
  }
}

/** The shared upload preview resolves stored names through BFF metadata, never pro Auth. */
export async function fetchAttachmentDisplayNames(
  urls: string[],
  tenantId: string
): Promise<Record<string, string>> {
  if (tenantId !== bffSession.value?.user.tenantId) return {}
  const pairs = urls.flatMap((url) => {
    const match = resourceUrl.exec(url)
    return match ? [{ url, id: match[1] }] : []
  })
  if (!pairs.length) return {}
  if (pairs.length > 50) throw new BffApiError('每次最多查询 50 个附件名称', 400)
  const params = new URLSearchParams({ ids: pairs.map((item) => item.id).join(',') })
  const names = await call<Record<string, string>>(`/api/resources/names?${params}`)
  return Object.fromEntries(
    pairs.flatMap((item) => {
      const name = names[item.id]
      return name ? [[item.url, name]] : []
    })
  )
}
