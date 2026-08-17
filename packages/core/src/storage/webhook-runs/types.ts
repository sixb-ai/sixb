import type { SixbErrorCode, SixbFailure } from "../../errors/types"

export type WebhookRunStatus = "running" | "succeeded" | "failed"
export type FinishWebhookRunStatus = Exclude<WebhookRunStatus, "running">

/** Error codes a webhook run can persist and expose through its public contract. */
export const WEBHOOK_RUN_FAILURE_CODES = [
  "internal.unexpected",
  "webhook.delivery_failed",
  "webhook.delivery_rejected",
] as const satisfies readonly [SixbErrorCode, ...SixbErrorCode[]]

export type WebhookRunFailureCode = (typeof WEBHOOK_RUN_FAILURE_CODES)[number]

export interface WebhookRunRecord {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly connectorId: string
  readonly webhookId: string
  readonly status: WebhookRunStatus
  readonly method: string
  readonly route: string
  readonly startedAt: Date
  readonly finishedAt?: Date
  readonly requestBodyBytes: number
  readonly requestBodySha256: string
  readonly responseStatus?: number
  readonly idempotencyKey?: string
  readonly error?: SixbFailure<WebhookRunFailureCode>
}

export interface StartWebhookRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly connectorId: string
  readonly webhookId: string
  readonly method: string
  readonly route: string
  readonly requestBodyBytes: number
  readonly requestBodySha256: string
  readonly idempotencyKey?: string
  readonly startedAt?: Date
}

export interface RestartWebhookRunInput {
  readonly id: string
  readonly projectId: string
  readonly startedAt?: Date
}

interface FinishWebhookRunBaseInput {
  readonly id: string
  readonly projectId: string
  readonly finishedAt?: Date
  readonly responseStatus?: number
}

export type FinishWebhookRunInput = FinishWebhookRunBaseInput &
  (
    | {
        readonly status: "succeeded"
        readonly error?: never
      }
    | {
        readonly status: "failed"
        readonly error: SixbFailure<WebhookRunFailureCode>
      }
  )

export interface GetWebhookRunByDeliveryInput {
  readonly projectId: string
  readonly connectorId: string
  readonly webhookId: string
  readonly idempotencyKey: string
}

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
  restart(input: RestartWebhookRunInput): Promise<WebhookRunRecord>
  finish(input: FinishWebhookRunInput): Promise<WebhookRunRecord>
  getById(params: { projectId: string; id: string }): Promise<WebhookRunRecord | null>
  getByDelivery(input: GetWebhookRunByDeliveryInput): Promise<WebhookRunRecord | null>
  list(input: ListWebhookRunsInput): Promise<ListWebhookRunsResult>
}

/** Provider retries may reopen only failures classified as retryable by the shared error policy. */
export function canRetryWebhookRun(run: WebhookRunRecord): boolean {
  return run.status === "failed" && run.error?.retryable === true
}
