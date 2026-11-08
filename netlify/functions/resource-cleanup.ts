import { runResourceCleanup } from '../../server/resources'

export default async function (): Promise<void> {
  await runResourceCleanup()
}

export const config = { schedule: '* * * * *' }
