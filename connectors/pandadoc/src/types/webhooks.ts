import type { PandaDocItemsResponse, PandaDocJsonObject, PandaDocPageOptions } from "./common"

export type PandaDocWebhookTrigger =
  | "document_state_changed"
  | "document_completed_pdf_ready"
  | "document_updated"
  | "recipient_completed"
  | "document_deleted"
  | "document_creation_failed"
  | "document_section_added"
  | "quote_updated"
  | "template_created"
  | "template_updated"
  | "template_deleted"
  | "content_library_item_created"
  | "content_library_item_creation_failed"
  | (string & {})

export type PandaDocWebhookPayloadField =
  | "fields"
  | "products"
  | "pricing"
  | "tokens"
  | "metadata"
  | (string & {})

export interface PandaDocWebhookSubscription extends PandaDocJsonObject {
  readonly uuid: string
  readonly name?: string
  readonly url?: string
  readonly status?: "ACTIVE" | "INACTIVE" | (string & {})
  readonly active?: boolean
  readonly payload?: readonly PandaDocWebhookPayloadField[]
  readonly triggers?: readonly PandaDocWebhookTrigger[]
  readonly shared_key?: string
  readonly workspace_id?: string
}

export interface PandaDocWebhookSubscriptionInput extends PandaDocJsonObject {
  readonly name: string
  readonly url: string
  readonly active?: boolean
  readonly payload?: readonly PandaDocWebhookPayloadField[]
  readonly triggers: readonly PandaDocWebhookTrigger[]
}

export interface PandaDocWebhookSubscriptionUpdateInput extends PandaDocJsonObject {
  readonly name?: string
  readonly url?: string
  readonly active?: boolean
  readonly payload?: readonly PandaDocWebhookPayloadField[]
  readonly triggers?: readonly PandaDocWebhookTrigger[]
}

export type PandaDocWebhookSubscriptionListOptions = PandaDocPageOptions

export type PandaDocWebhookSubscriptionListResponse =
  PandaDocItemsResponse<PandaDocWebhookSubscription>

export interface PandaDocWebhookEventRecord extends PandaDocJsonObject {
  readonly id?: string
  readonly uuid?: string
  readonly event?: string
  readonly status?: string
  readonly date_created?: string
}

export type PandaDocWebhookEventListOptions = PandaDocPageOptions
export type PandaDocWebhookEventListResponse = PandaDocItemsResponse<PandaDocWebhookEventRecord>
