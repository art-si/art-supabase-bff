import { config } from './config'
import { database } from './database/client'
import { isObjectRecord } from 'art-supabase-pro/src/utils/record.ts'

let running = false
let consecutiveFailures = 0
let nextRunAt = 0

/** Database advisory locking and per-rule deduplication coordinate separate BFF processes. */
export async function runAlertEvaluationBatch(timeoutMs = 45_000): Promise<void> {
  if (running || Date.now() < nextRunAt || !config.databaseUrl || !config.databaseKey) return
  running = true
  try {
    const result = await database
      .rpc('bff_alert_evaluate_batch', { p_limit: 100 })
      .abortSignal(AbortSignal.timeout(timeoutMs))
    if (result.error) throw new Error('告警评估数据库调用失败', { cause: result.error })
    const data: unknown = result.data
    if (!isObjectRecord(data) || typeof data.evaluated !== 'number')
      throw new Error('告警评估返回数据无效')
    if (consecutiveFailures > 0) console.info('[BFF] 告警评估已恢复')
    consecutiveFailures = 0
    nextRunAt = 0
  } catch (error) {
    consecutiveFailures += 1
    const backoff = Math.min(
      900_000,
      config.alertWorkerIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 4)
    )
    nextRunAt = Date.now() + backoff
    // Once per failure streak keeps diagnostics useful without flooding logs.
    if (consecutiveFailures === 1)
      console.error('[BFF] 告警评估暂不可用，将自动降频重试', {
        code:
          isObjectRecord(error) &&
          isObjectRecord(error.cause) &&
          typeof error.cause.code === 'string' &&
          /^[A-Z0-9_]{1,20}$/.test(error.cause.code)
            ? error.cause.code
            : 'UNKNOWN'
      })
  } finally {
    running = false
  }
}

export function startAlertWorker(): () => void {
  const timer = setInterval(() => {
    void runAlertEvaluationBatch()
  }, config.alertWorkerIntervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
