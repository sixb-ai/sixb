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

/**
 * How long a webhook run stays held without a sign of life. Like the lease of a dataset flush, it
 * survives three renewals lost in a row, so a database blip never runs a live handler twice, and
 * it ends long before most providers retry, so a crash costs a delivery one retry at worst.
 */
export const WEBHOOK_RUN_LEASE_MS = 60_000

/**
 * Who is running a webhook's handler. A handler runs inside its request, with no queue to redeliver
 * it, so the process keeps this lease alive for as long as the handler runs.
 */
export interface WebhookRunExecution {
  readonly token: string
  readonly leaseExpiresAt: Date
}

export interface WebhookRunRecord {
  readonly id: string
  readonly projectId: string
  readonly executionId: string
  readonly connectorId: string
  readonly webhookId: string
  readonly status: WebhookRunStatus
  /** Absent once the run has finished. */
  readonly execution?: WebhookRunExecution
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
  readonly execution: WebhookRunExecution
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
  readonly execution: WebhookRunExecution
  readonly startedAt?: Date
}

export interface RenewWebhookRunInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
  readonly leaseExpiresAt: Date
}

interface FinishWebhookRunBaseInput {
  readonly id: string
  readonly projectId: string
  readonly executionToken: string
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
  /** Keeps a live handler's run held. False once the token no longer holds a running run. */
  renewLease(input: RenewWebhookRunInput): Promise<boolean>
  finish(input: FinishWebhookRunInput): Promise<WebhookRunRecord>
  getById(params: { projectId: string; id: string }): Promise<WebhookRunRecord | null>
  getByDelivery(input: GetWebhookRunByDeliveryInput): Promise<WebhookRunRecord | null>
  list(input: ListWebhookRunsInput): Promise<ListWebhookRunsResult>
}

/**
 * A provider retry may reopen a failure classified as retryable by the shared error policy, and a
 * run whose lease ran out: the process running its handler is gone, or the retry would be waiting
 * on a run that never ends.
 */
export function canRetryWebhookRun(run: WebhookRunRecord, now: Date = new Date()): boolean {
  if (run.status === "failed") return run.error?.retryable === true
  if (run.status !== "running") return false

  // A run with no lease was started by an older API, which renews nothing.
  const leaseExpiresAt =
    run.execution?.leaseExpiresAt.getTime() ?? run.startedAt.getTime() + WEBHOOK_RUN_LEASE_MS

  return leaseExpiresAt <= now.getTime()
}
