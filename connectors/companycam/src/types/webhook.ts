import type { PageOptions } from "./common"

/**
 * Webhook event scopes. The documented values give autocomplete; the
 * `(string & {})` member keeps it open to scopes CompanyCam adds later.
 */
export type CompanyCamEventType =
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "project.archived"
  | "project.label_added"
  | "project.contact_created"
  | "project.contact_updated"
  | "project.merged"
  | "photo.created"
  | "photo.updated"
  | "photo.tag_added"
  | "photo.description_updated"
  | "comment.created"
  | "document.created"
  | "document.updated"
  | "video.created"
  | "video.updated"
  | "todo_list.created"
  | "todo_list.completed"
  | "todo_list.deleted"
  | "task.completed"
  // `string & {}` keeps literal autocomplete while still accepting scopes CompanyCam adds later.
  | (string & {})

export interface CompanyCamWebhook {
  readonly id: string
  readonly company_id?: string
  readonly url: string
  readonly scopes: readonly string[]
  readonly enabled: boolean
  readonly token?: string
  /** Unix epoch seconds. */
  readonly created_at?: number
  /** Unix epoch seconds. */
  readonly updated_at?: number
}

export interface CreateWebhookInput {
  /** Endpoint CompanyCam delivers events to. */
  readonly url: string
  readonly scopes: readonly CompanyCamEventType[]
  /** Defaults to `true`. */
  readonly enabled?: boolean
  /** HMAC key for signing deliveries. Defaults to the connector's `webhookSecret`. */
  readonly token?: string
}

export interface UpdateWebhookInput {
  readonly url?: string
  readonly scopes?: readonly CompanyCamEventType[]
  readonly enabled?: boolean
  readonly token?: string
}

export type ListWebhooksOptions = PageOptions
