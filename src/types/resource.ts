/** Browser-visible metadata only. Storage paths, content hashes and claim tokens stay server-side. */
export const RESOURCE_MIME_SUFFIXES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/x-icon': ['ico'],
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/msword': ['doc'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'audio/mpeg': ['mp3'],
  'video/mp4': ['mp4'],
  'audio/ogg': ['ogg'],
  'audio/wav': ['wav'],
  'video/webm': ['webm'],
  'application/zip': ['zip'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'application/json': ['json']
})

export interface BffResource {
  id: number
  tenantId: string
  originName: string
  mimeType: string
  suffix: string
  sizeByte: number
  sizeInfo: string
  url: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface BffResourceList {
  data: BffResource[]
  total: number
}

/** Matches the shared deletion guard's stable fields without importing browser APIs. */
export interface BffResourceReference {
  resourceId: string
  dependencyCode: 'logoUrl' | 'faviconUrl' | 'wordmarkLightUrl' | 'wordmarkDarkUrl'
  recordId: string
  targetId: string
  recordNo: string
  recordSummary: string | null
  recordStatus: string | null
  recordAmount: number | null
  createdAt: string
  cleanupAllowed: boolean
}
