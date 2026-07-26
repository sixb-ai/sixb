import type { MercuryCursorOptions, MercuryPageCursors, MercuryTimestamp } from "./common"

export type MercuryWebhookEventType =
  | "transaction.created"
  | "transaction.updated"
  | "checkingAccount.balance.updated"
  | "savingsAccount.balance.updated"
  | "treasuryAccount.balance.updated"
  | "investmentAccount.balance.updated"
  | "creditAccount.balance.updated"

/**
 * Resource field paths accepted by `filterPaths`. When set, Mercury only delivers an event if one
 * of these fields changed.
 */
export type MercuryWebhookResourceField =
  | "transaction.amount"
  | "transaction.bankDescription"
  | "transaction.categoryData"
  | "transaction.customCategory"
  | "transaction.customCategory.id"
  | "transaction.customCategory.name"
  | "transaction.mercuryCategory"
  | "transaction.estimatedDeliveryDate"
  | "transaction.externalMemo"
  | "transaction.failedAt"
  | "transaction.note"
  | "transaction.postedAt"
  | "transaction.reasonForFailure"
  | "transaction.status"
  | "checkingAccount.availableBalance"
  | "checkingAccount.currentBalance"
  | "checkingAccount.inFlightBalance"
  | "savingsAccount.availableBalance"
  | "savingsAccount.currentBalance"
  | "savingsAccount.inFlightBalance"
  | "treasuryAccount.availableBalance"
  | "treasuryAccount.currentBalance"
  | "treasuryAccount.inFlightBalance"
  | "investmentAccount.availableBalance"
  | "investmentAccount.currentBalance"
  | "investmentAccount.inFlightBalance"
  | "creditAccount.availableBalance"
  | "creditAccount.currentBalance"
  | "creditAccount.inFlightBalance"

/**
 * `disabled` is set by Mercury after consecutive delivery failures. Reactivate by updating the
 * endpoint's status back to `active`.
 */
export type MercuryWebhookStatus = "active" | "paused" | "disabled"

/** Only `active` and `paused` may be set through the API. */
export type MercuryWebhookUpdateStatus = "active" | "paused"

/** `deleted` appears only as a list filter, never as an endpoint's own status. */
export type MercuryWebhookStatusFilter = MercuryWebhookStatus | "deleted"

export interface MercuryWebhookEndpoint {
  readonly id: string
  readonly url: string
  readonly status: MercuryWebhookStatus
  readonly createdAt: MercuryTimestamp
  readonly updatedAt: MercuryTimestamp
  /** Absent means every event type is delivered. */
  readonly eventTypes?: readonly MercuryWebhookEventType[] | null
  /** Absent means no field filtering. */
  readonly filterPaths?: readonly MercuryWebhookResourceField[] | null
  /**
   * Signing secret for `Mercury-Signature`. Returned only when the endpoint is created — store it
   * then, because reads never include it.
   */
  readonly secret?: string | null
}

export interface MercuryWebhooksResponse {
  readonly webhooks: readonly MercuryWebhookEndpoint[]
  readonly page: MercuryPageCursors
}

export interface MercuryWebhookListOptions extends MercuryCursorOptions {
  readonly status?: readonly MercuryWebhookStatusFilter[]
}

export interface MercuryCreateWebhookInput {
  /** HTTPS URL that receives deliveries. */
  readonly url: string
  /** Omit to subscribe to every event type. */
  readonly eventTypes?: readonly MercuryWebhookEventType[] | null
  /** Omit for no field filtering. */
  readonly filterPaths?: readonly MercuryWebhookResourceField[] | null
}

/** Every field is optional; omitted fields are left unchanged, and `null` clears a filter. */
export interface MercuryUpdateWebhookInput {
  readonly url?: string
  readonly status?: MercuryWebhookUpdateStatus
  readonly eventTypes?: readonly MercuryWebhookEventType[] | null
  readonly filterPaths?: readonly MercuryWebhookResourceField[] | null
}

export interface MercuryVerifyWebhookInput {
  /** Event type to send as the test delivery. Defaults to `transaction.created`. */
  readonly eventType?: MercuryWebhookEventType
}
