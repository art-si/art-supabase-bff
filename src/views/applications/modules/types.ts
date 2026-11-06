import type { BffApplication } from '@bff/types/bff'
export interface ApplicationDialogExpose {
  handleOpen: (application?: BffApplication) => Promise<void>
}
export interface ApplicationMembersDialogExpose {
  handleOpen: (application: BffApplication) => Promise<void>
}
