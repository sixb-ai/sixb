import type { Logger, Sixb } from "@sixb/core"
import type { CtmCall } from "./calls"
import type { CtmClient } from "./client"

/** When a CTM webhook fires. */
export type CtmWebhookTrigger =
  /** An inbound call or other activity starts. */
  | "start"
  /** An outbound call or other activity starts. */
  | "start_outbound"
  /** An agent answers. */
  | "answered"
  | "hangup"
  /** Website session data is attached to the activity. */
  | "session"
  /** The caller's leg disconnects. */
  | "end_immediate"
  | "end"
  /** One hour after the call ends, once late data such as transcripts has arrived. */
  | "end_delayed"
  /** Any change to the activity. Fires often. */
  | "update"
  | "sale"
  | "form"
  /** Paid attribution data is available. */
  | "paid"
  | "geokey"
  | "inbound_text"
  | "outbound_text"

/**
 * What CTM sends: the whole activity (`call`), a link to fetch it later (`ref`), or a ping to a
 * tracking pixel (`pixel`). The connector's `events` route reads `call`.
 */
export type CtmWebhookType = "call" | "ref" | "pixel"

export interface CtmWebhookInput {
  /** The URL CTM posts to. */
  readonly weburl: string
  /** When it fires. CTM defaults to `end`. */
  readonly position?: CtmWebhookTrigger
  readonly name?: string
  readonly description?: string
  readonly hooktype?: CtmWebhookType
  /** Sent as basic auth on every delivery: the credential the `events` route checks. */
  readonly username?: string
  readonly password?: string
}

export interface CtmWebhook {
  readonly id: number
  readonly account_id: number
  readonly name: string | null
  readonly description: string | null
  readonly weburl: string
  readonly position: CtmWebhookTrigger | (string & {})
  readonly with_resource_url?: boolean
  readonly username?: string | null
  readonly password?: string | null
  readonly client_type?: string
  readonly client_id?: number
  readonly webhook_conditions?: readonly unknown[]
  readonly [field: string]: unknown
}

export interface CtmWebhookCreateResult {
  readonly status: string | boolean
  readonly webhook: CtmWebhook
  readonly warnings: Readonly<Record<string, unknown>>
}

export interface CtmChangeNotificationInput {
  readonly name: string
  /** The URL CTM posts each change to. */
  readonly deliver_to: string
  /**
   * The object types to report, such as `VirtualPhoneNumber` (tracking numbers),
   * `PhysicalPhoneNumber` (receiving numbers) or `CustomField`.
   */
  readonly included_data: readonly string[]
}

/** A subscription to configuration changes, delivered to a URL. */
export interface CtmChangeNotification {
  readonly id?: number
  readonly name: string
  readonly account_id: number
  readonly deliver_to: string
  readonly included_data: readonly string[]
  /** Seconds since the epoch. */
  readonly created_at: number
  /** Seconds since the epoch. */
  readonly updated_at: number
}

export interface CtmChangeNotificationResult {
  readonly id: number
  readonly status: string
  readonly action?: string
  readonly message?: string
}

/** One inbound delivery of a CTM webhook. */
export interface CtmEvent {
  /**
   * The `trigger` query parameter of the URL the webhook was registered with, or `null`. CTM does
   * not say which trigger fired, so a project with several webhooks names it in each URL.
   */
  readonly trigger: CtmWebhookTrigger | (string & {}) | null
  /** The activity as CTM sent it: a call, a text message or a form submission. */
  readonly activity: CtmCall
}

/** Context passed to the connector's `onEvent` handler for each inbound delivery. */
export interface CtmEventContext {
  readonly event: CtmEvent
  readonly request: Request
  readonly sixb: Sixb
  readonly logger: Logger
  /** Resolves the CTM client lazily, only if the handler needs to read back. */
  client(): Promise<CtmClient>
}

export type CtmEventHandler = (context: CtmEventContext) => Promise<void> | void

/** The basic-auth credential CTM sends with each delivery, set on the webhook in CTM. */
export interface CtmWebhookBasicAuth {
  readonly username: string
  readonly password: string
}
