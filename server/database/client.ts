import { createClient } from '@supabase/supabase-js'
import { config } from '../config'
import { remoteFetch } from '../remote-http'

export const database = createClient(
  config.databaseUrl || 'http://localhost',
  config.databaseKey || 'not-configured',
  { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: remoteFetch } }
)
export function requireData<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw new Error('数据库操作失败', { cause: result.error })
  if (result.data === null) throw new Error('记录不存在')
  return result.data
}
