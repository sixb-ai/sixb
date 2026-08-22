import type { QueueJobFailure, Queues, SyncQueueJobFailureCode } from "../src/queues"

declare const queues: Queues

const failure = {
  code: "runtime.cancelled",
  retryable: false,
  message: "Sync delivery was cancelled.",
  at: "2026-01-01T00:00:00.000Z",
} as const satisfies QueueJobFailure<SyncQueueJobFailureCode>

void queues.syncRuns.fail({
  projectId: "project-a",
  jobId: "job-a",
  leaseId: "lease-a",
  failure,
})

void queues.syncRuns.retry({
  projectId: "project-a",
  jobId: "job-a",
  leaseId: "lease-a",
  // @ts-expect-error Retry settlement does not claim to persist an attempt failure.
  failure,
})

const unrelatedFailure = {
  // @ts-expect-error A sync queue cannot expose a webhook failure code.
  code: "webhook.delivery_failed",
  retryable: true,
  message: "Webhook delivery failed.",
  at: "2026-01-01T00:00:00.000Z",
} as const satisfies QueueJobFailure<SyncQueueJobFailureCode>

void unrelatedFailure
