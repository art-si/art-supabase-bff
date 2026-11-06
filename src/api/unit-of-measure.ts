export * from 'art-supabase-pro/src/api/unit-of-measure'
import type { QueryResult } from '@/types/api/response'
/** BFF owns no material units; its business options come from the BFF dictionary. */
export async function fetchMaterialUnitCompatibilityOptions(
  _sourceCode?: string
): Promise<
  QueryResult<
    Array<Api.DataCenter.DictListItem & { dictTypeTable: { code: string; name: string } }>
  >
> {
  void _sourceCode
  return { data: [], error: null }
}
