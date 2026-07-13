import type { RestRetryPolicy } from "@sixb/connector-rest"
import type { Logger, OntologySource, Sixb } from "@sixb/core"
import type { PandaDocClient } from "./client"

export type PandaDocKeyResolver = string | (() => string | Promise<string>)

export type PandaDocWebhookSharedKeyResolver = string | (() => string | Promise<string>)

export interface PandaDocConnectorOptions {
  readonly apiKey: PandaDocKeyResolver
  /** API base URL. Defaults to https://api.pandadoc.com/. */
  readonly baseUrl?: string
  readonly timeoutMs?: number
  readonly minDelayMs?: number
  readonly retry?: RestRetryPolicy
  readonly webhookSharedKey?: PandaDocWebhookSharedKeyResolver
  readonly onEvent?: PandaDocWebhookEventHandler
}

export type PandaDocJsonValue =
  | string
  | number
  | boolean
  | null
  | PandaDocJsonObject
  | readonly PandaDocJsonValue[]

export interface PandaDocJsonObject {
  readonly [key: string]: PandaDocJsonValue | undefined
}

export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | readonly QueryScalar[] | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>

export interface PandaDocPageOptions {
  readonly [key: string]: QueryValue
  readonly page?: number
  readonly count?: number
}

export interface PandaDocResultsResponse<TItem> {
  readonly [key: string]: unknown
  readonly results: readonly TItem[]
}

export interface PandaDocItemsResponse<TItem> {
  readonly [key: string]: unknown
  readonly items: readonly TItem[]
}

export interface PandaDocLink extends PandaDocJsonObject {
  readonly rel?: string
  readonly href?: string
  readonly type?: string
}

export type PandaDocDocumentStatus =
  | "document.uploaded"
  | "document.error"
  | "document.draft"
  | "document.sent"
  | "document.viewed"
  | "document.waiting_approval"
  | "document.rejected"
  | "document.approved"
  | "document.waiting_pay"
  | "document.paid"
  | "document.completed"
  | "document.cancelled"
  | "document.voided"
  | "document.declined"
  | "document.external_review"
  | (string & {})

export type PandaDocDocumentStatusCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13

export interface PandaDocWebhookEvent extends PandaDocJsonObject {
  readonly event: PandaDocWebhookEventName
  readonly data: PandaDocJsonObject
}

export type PandaDocWebhookEventName =
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

export interface PandaDocWebhookEventContext {
  readonly event: PandaDocWebhookEvent
  readonly events: readonly PandaDocWebhookEvent[]
  readonly request: Request
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly logger: Logger
  client(): Promise<PandaDocClient>
}

export type PandaDocWebhookEventHandler = (
  context: PandaDocWebhookEventContext
) => Promise<void> | void
