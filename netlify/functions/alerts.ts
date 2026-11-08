import { runAlertEvaluationBatch } from '../../server/alert-worker'

export default async function (): Promise<void> {
  await runAlertEvaluationBatch(20_000)
}

export const config = { schedule: '* * * * *' }
