import type { Logger, OntologySource, Sixb } from "@sixb/core"
import type { UnipileClient } from "./client"
import type { UnipileCursorOptions, UnipileCursorPage, UnipileTimestamp } from "./common"
import type { UnipileMessageAttachment } from "./messages"

export interface UnipileWebhookHeader {
  readonly key: string
  readonly value: string
}

interface UnipileCreateWebhookBaseInput {
  readonly request_url: string
  readonly name?: string
  readonly format?: "json" | "form"
  readonly account_ids?: readonly string[]
  readonly enabled?: boolean
  readonly headers?: readonly UnipileWebhookHeader[]
}

export type UnipileMessagingWebhookEventName =
  | "message_received"
  | "message_read"
  | "message_reaction"
  | "message_edited"
  | "message_deleted"
  | "message_delivered"

export interface UnipileCreateMessagingWebhookInput extends UnipileCreateWebhookBaseInput {
  readonly source: "messaging"
  readonly events?: readonly UnipileMessagingWebhookEventName[]
}

export interface UnipileCreateUsersWebhookInput extends UnipileCreateWebhookBaseInput {
  readonly source: "users"
  readonly events?: readonly ["new_relation"]
}

export type UnipileAccountStatusWebhookEventName =
  | "OK"
  | "ERROR"
  | "STOPPED"
  | "CREDENTIALS"
  | "CONNECTING"
  | "DELETED"
  | "CREATION_SUCCESS"
  | "RECONNECTED"
  | "SYNC_SUCCESS"
  | (string & {})

export interface UnipileCreateAccountStatusWebhookInput extends UnipileCreateWebhookBaseInput {
  readonly source: "account_status"
  /** Statuses to deliver. Set explicitly because Unipile's defaults omit some lifecycle states. */
  readonly events?: readonly UnipileAccountStatusWebhookEventName[]
}

export type UnipileCreateWebhookInput =
  | UnipileCreateMessagingWebhookInput
  | UnipileCreateUsersWebhookInput
  | UnipileCreateAccountStatusWebhookInput

export interface UnipileWebhook {
  readonly object: "Webhook"
  readonly id: string
  readonly request_url: string
  readonly enabled: boolean
  readonly name?: string
  readonly source?: string
  readonly events?: readonly string[]
  readonly account_ids?: readonly unknown[]
  readonly headers?: readonly UnipileWebhookHeader[]
  readonly format?: "json" | "form"
  readonly [key: string]: unknown
}

export type UnipileWebhookListOptions = UnipileCursorOptions
export type UnipileWebhooksResponse = UnipileCursorPage<UnipileWebhook>

export interface UnipileWebhookCreated {
  readonly object: "WebhookCreated"
  readonly webhook_id: string
}

export interface UnipileWebhookDeleted {
  readonly object: "WebhookDeleted"
}

export interface UnipileWebhookAttendee {
  readonly attendee_id: string
  readonly attendee_name: string
  readonly attendee_provider_id: string
  readonly attendee_profile_url?: string
}

export interface UnipileMessageWebhookEvent {
  readonly kind: "message"
  readonly event: UnipileMessagingWebhookEventName
  readonly account_id: string
  readonly account_type: string
  readonly account_info?: {
    readonly type?: string
    readonly feature?: string
    readonly user_id?: string
    readonly [key: string]: unknown
  }
  readonly chat_id: string
  readonly timestamp: UnipileTimestamp
  readonly webhook_name?: string
  readonly message_id: string
  readonly message: string | null
  readonly sender: UnipileWebhookAttendee
  readonly attendees: readonly UnipileWebhookAttendee[]
  readonly attachments: readonly UnipileMessageAttachment[]
  readonly reaction?: string
  readonly reaction_sender?: UnipileWebhookAttendee
  readonly [key: string]: unknown
}

export type UnipileAccountLifecycleStatus = UnipileAccountStatusWebhookEventName

export interface UnipileAccountStatusWebhookEvent {
  readonly kind: "account_status"
  readonly AccountStatus: {
    readonly account_id: string
    readonly account_type: string
    readonly message: UnipileAccountLifecycleStatus
    readonly product?: string
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

export interface UnipileNewRelationWebhookEvent {
  readonly kind: "new_relation"
  readonly event: "new_relation"
  readonly account_id: string
  readonly account_type: "LINKEDIN"
  readonly webhook_name?: string
  readonly user_full_name: string
  readonly user_provider_id: string
  readonly user_public_identifier: string
  readonly user_profile_url: string
  readonly user_picture_url?: string
  readonly [key: string]: unknown
}

export type UnipileWebhookEvent =
  | UnipileMessageWebhookEvent
  | UnipileAccountStatusWebhookEvent
  | UnipileNewRelationWebhookEvent

export interface UnipileEventContext {
  readonly event: UnipileWebhookEvent
  readonly request: Request
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly logger: Logger
  client(): Promise<UnipileClient>
}

export type UnipileEventHandler = (context: UnipileEventContext) => Promise<void> | void
