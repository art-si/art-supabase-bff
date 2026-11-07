import type { DeleteReferenceContext } from '@/utils/supabase/delete-reference'
import type {
  MasterDataDeleteDependencyDetail,
  MasterDataDeleteResourceType,
  RecordDeleteDependency
} from 'art-supabase-pro/src/api/master-data-delete'
import { call } from '@bff/api/bff'
export * from 'art-supabase-pro/src/api/master-data-delete'
export function fetchRecordDeleteDependencies(
  context: DeleteReferenceContext
): Promise<RecordDeleteDependency[]> {
  return call('/api/control/references', {
    method: 'POST',
    body: JSON.stringify({ table: context.table, ids: context.ids })
  })
}
export function fetchMasterDataDeleteDependencies(
  resourceType: MasterDataDeleteResourceType,
  ids: string[]
): Promise<MasterDataDeleteDependencyDetail[]> {
  return call(
    resourceType === 'attachment' ? '/api/resources/references' : '/api/control/references',
    {
      method: 'POST',
      body: JSON.stringify({ resourceType, ids })
    }
  )
}
