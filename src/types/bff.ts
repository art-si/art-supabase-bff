export interface BffUser {
  id: string
  name: string
  email: string
  role: 'admin' | 'viewer'
  tenantId: string
}
import type { AppRouteRecord } from 'art-supabase-pro/src/types/router/index'
export type BffMenu = AppRouteRecord
export interface BffSession {
  user: BffUser
  csrfToken: string
  permissions: string[]
  menu: BffMenu[]
}
export interface BffApplication {
  id: string
  code: string
  name: string
  description: string
  homeUrl: string
  enabled: boolean
  version: number
  createdAt: string
  updatedAt: string
}
export interface ApplicationInput {
  code: string
  name: string
  description: string
  homeUrl: string
  enabled: boolean
  version?: number
}
export interface ApplicationMember {
  id: string
  name: string
  email: string
  role: 'admin' | 'viewer'
  enabled: boolean
  granted: boolean
}
export interface ApplicationList {
  records: BffApplication[]
  total: number
  current: number
  size: number
}
