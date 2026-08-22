import type { SixbErrorCode, SixbFailure } from "../../errors/types"

export type WebhookDeliveryClaimResult = "claimed" | "duplicate" | "in_progress"
export type WebhookDeliveryStatus = "in_progress" | "completed" | "failed"

/** Error codes a retryable inbound webhook delivery can persist and expose. */
export const WEBHOOK_DELIVERY_FAILURE_CODES = [
  "webhook.delivery_failed",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type WebhookDeliveryFailureCode = (typeof WEBHOOK_DELIVERY_FAILURE_CODES)[number]
export type WebhookDeliveryFailure = SixbFailure<WebhookDeliveryFailureCode>

export interface WebhookDeliveryKey {
  readonly projectId: string
  readonly connectorId: string
  readonly webhookId: string
  readonly idempotencyKey: string
}

export interface WebhookDeliveryRecord extends WebhookDeliveryKey {
  readonly status: WebhookDeliveryStatus
  readonly receivedAt?: string
  readonly completedAt?: string
  readonly failedAt?: string
  readonly failure?: WebhookDeliveryFailure
}

export interface WebhookDeliveryClaimRecord extends WebhookDeliveryRecord {
  readonly claimResult: WebhookDeliveryClaimResult
}

/**
 * Durable ledger used by idempotent webhooks to claim provider delivery ids.
 *
 * Implementations must make `claim(...)` atomic for a scoped key so duplicate
 * provider retries cannot run the same handler concurrently.
 */
export interface WebhookDeliveryStorage {
  /**
   * Atomically reserve a provider delivery key.
   *
   * New or previously failed keys return "claimed". Completed keys return
   * "duplicate", and keys currently being handled return "in_progress".
   */
  claim(input: WebhookDeliveryKey & { receivedAt: string }): Promise<WebhookDeliveryClaimRecord>
  complete(input: WebhookDeliveryKey & { completedAt: string }): Promise<WebhookDeliveryRecord>
  fail(
    input: WebhookDeliveryKey & { failedAt: string; failure: WebhookDeliveryFailure }
  ): Promise<WebhookDeliveryRecord>
}
