import type { SixbErrorCode, SixbFailure } from "../../errors/types"
import type { WebhookDeliveryClaimResult } from "../webhook-deliveries"

export type WebhookRunStatus = "running" | "succeeded" | "failed" | "skipped"
export type FinishWebhookRunStatus = Exclude<WebhookRunStatus, "running">

/** Error codes a webhook run can persist and expose through its public contract. */
export const WEBHOOK_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "webhook.delivery_failed",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type WebhookRunFailureCode = (typeof WEBHOOK_RUN_FAILURE_CODES)[number]

export interface WebhookRunRecord {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly webhookId: string
  readonly status: WebhookRunStatus
  readonly method: string
  readonly route: string
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly requestBodyBytes?: number
  readonly responseStatus?: number
  readonly idempotencyKey?: string
  readonly deliveryClaimResult?: WebhookDeliveryClaimResult
  readonly error?: SixbFailure<WebhookRunFailureCode>
}

export interface StartWebhookRunInput {
  readonly id: string
  readonly projectId: string
  readonly connectorId: string
  readonly webhookId: string
  readonly method: string
  readonly route: string
  readonly startedAt?: Date
}

interface FinishWebhookRunBaseInput {
  readonly id: string
  readonly projectId: string
  readonly finishedAt?: Date
  readonly requestBodyBytes?: number
  readonly responseStatus?: number
  readonly idempotencyKey?: string
  readonly deliveryClaimResult?: WebhookDeliveryClaimResult
}

export type FinishWebhookRunInput = FinishWebhookRunBaseInput &
  (
    | {
        readonly status: "succeeded" | "skipped"
        readonly error?: never
      }
    | {
        readonly status: "failed"
        readonly error: SixbFailure<WebhookRunFailureCode>
      }
  )

export interface ListWebhookRunsInput {
  readonly projectId: string
  readonly connectorId?: string
  readonly webhookId?: string
  readonly statuses?: readonly WebhookRunStatus[]
  readonly idempotencyKey?: string
  readonly startedAfter?: Date
  readonly startedBefore?: Date
  readonly limit?: number
  readonly offset?: number
  readonly order?: "asc" | "desc"
}

export interface ListWebhookRunsResult {
  readonly runs: readonly WebhookRunRecord[]
  readonly hasMore: boolean
  readonly total: number
}

export interface WebhookRunStorage {
  start(input: StartWebhookRunInput): Promise<WebhookRunRecord>
  finish(input: FinishWebhookRunInput): Promise<WebhookRunRecord>
  getById(params: { projectId: string; id: string }): Promise<WebhookRunRecord | null>
  list(input: ListWebhookRunsInput): Promise<ListWebhookRunsResult>
}
