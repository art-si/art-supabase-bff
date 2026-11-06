import { call } from '@bff/api/bff'
export async function isFieldValueTaken(params: {
  table: string
  field: string
  value: string
  excludeId?: string
  extraWhere?: Record<string, string | number | boolean | null | undefined>
}): Promise<boolean> {
  const result = await call<{ taken: boolean }>('/api/control/unique', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  return result.taken
}
