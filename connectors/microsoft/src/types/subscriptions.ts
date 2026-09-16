import type { RequestOptions } from "./common"

export type MailChangeType = "created" | "updated" | "deleted"

export interface MailSubscribeOptions extends RequestOptions {
  /** Omit to watch messages across the mailbox. */
  readonly folderId?: string
  readonly changeTypes: readonly MailChangeType[]
  readonly notificationUrl: string
  /** Defaults to notificationUrl. */
  readonly lifecycleNotificationUrl?: string
  readonly expirationDateTime: string
}

export interface MicrosoftSubscription {
  readonly id: string
  readonly resource?: string
  readonly changeType?: string
  readonly notificationUrl?: string
  readonly lifecycleNotificationUrl?: string
  readonly expirationDateTime?: string
  readonly applicationId?: string
  readonly creatorId?: string
  readonly clientState?: string | null
}
