import { randomUUID } from "node:crypto"
import { createPrimitiveExecutionRecord } from "../execution/durable"
import type { ExecutionRecord, Storage, WebhookRunExecution, WebhookRunRecord } from "../storage"
import {
  canRetryWebhookRun,
  ExecutionStorageError,
  isStorageSerializationFailure,
  WebhookRunError,
} from "../storage"
import { WEBHOOK_RUN_LEASE_MS } from "../storage/webhook-runs"

const MAX_ADMISSION_ATTEMPTS = 3

export interface AdmitWebhookRunInput {
  readonly projectId: string
  readonly storage: Storage
  readonly runId: string
  readonly connectorId: string
  readonly webhookId: string
  readonly method: string
  readonly route: string
  readonly requestBodyBytes: number
  readonly requestBodySha256: string
  readonly idempotencyKey?: string
}

export type AdmitWebhookRunResult =
  | {
      readonly status: "admitted"
      readonly run: WebhookRunRecord
      readonly execution: ExecutionRecord
      readonly retried: boolean
    }
  | {
      readonly status: "duplicate" | "in_progress"
      readonly run: WebhookRunRecord
    }

/** Persist or reclaim one verified Webhook delivery before its protected handler executes. */
export async function admitWebhookRun(input: AdmitWebhookRunInput): Promise<AdmitWebhookRunResult> {
  assertAdmissionInput(input)
  let attempt = 0

  // The run's unique delivery key decides between concurrent deliveries, at the default isolation:
  // a serializable transaction would also fail deliveries with distinct keys, whose lookups share
  // index pages. Two deliveries of one key may both observe no run; the loser's insert fails as a
  // duplicate once the winner commits, and its next attempt reloads the winning run. A restart
  // locks the failed run and changes it only while it is still failed, so one of several retries
  // restarts it and the others reload it running. Every other error fails immediately.
  while (true) {
    attempt += 1
    try {
      return await input.storage.transaction((tx) => admitWebhookRunTransaction(tx, input))
    } catch (error) {
      if (attempt >= MAX_ADMISSION_ATTEMPTS || !isConcurrentAdmissionConflict(error)) {
        throw error
      }
    }
  }
}

async function admitWebhookRunTransaction(
  storage: Storage,
  input: AdmitWebhookRunInput
): Promise<AdmitWebhookRunResult> {
  const runs = requireWebhookRunStorage(storage)
  const existing = input.idempotencyKey
    ? await runs.getByDelivery({
        projectId: input.projectId,
        connectorId: input.connectorId,
        webhookId: input.webhookId,
        idempotencyKey: input.idempotencyKey,
      })
    : null

  if (existing) {
    assertSameDelivery(existing, input)

    if (!canRetryWebhookRun(existing)) {
      return { status: existing.status === "running" ? "in_progress" : "duplicate", run: existing }
    }

    const execution = await requireWebhookExecution(storage, existing)
    const run = await runs.restart({
      projectId: input.projectId,
      id: existing.id,
      execution: freshWebhookExecution(),
    })
    return { status: "admitted", run, execution, retried: true }
  }

  const executionInput = createPrimitiveExecutionRecord({
    id: `exec_${randomUUID()}`,
    primitive: { kind: "webhook", id: input.route, runId: input.runId },
    origin: {
      type: "automatic",
      projectId: input.projectId,
      source: { type: "webhook", deliveryId: input.runId },
      correlationId: input.runId,
    },
  })
  const execution = await storage.executions.create(executionInput)
  const run = await runs.start({
    id: input.runId,
    projectId: input.projectId,
    executionId: execution.id,
    execution: freshWebhookExecution(),
    connectorId: input.connectorId,
    webhookId: input.webhookId,
    method: input.method,
    route: input.route,
    requestBodyBytes: input.requestBodyBytes,
    requestBodySha256: input.requestBodySha256,
    idempotencyKey: input.idempotencyKey,
  })
  return { status: "admitted", run, execution, retried: false }
}

function freshWebhookExecution(): WebhookRunExecution {
  return {
    token: `webhookx_${randomUUID()}`,
    leaseExpiresAt: new Date(Date.now() + WEBHOOK_RUN_LEASE_MS),
  }
}

function assertSameDelivery(existing: WebhookRunRecord, input: AdmitWebhookRunInput): void {
  if (
    existing.connectorId !== input.connectorId ||
    existing.webhookId !== input.webhookId ||
    existing.method !== input.method ||
    existing.route !== input.route ||
    existing.requestBodyBytes !== input.requestBodyBytes ||
    existing.requestBodySha256 !== input.requestBodySha256
  ) {
    throw new WebhookRunError(
      `[Sixb] Webhook delivery '${input.idempotencyKey}' conflicts with run '${existing.id}'.`,
      "delivery_conflict"
    )
  }
}

async function requireWebhookExecution(
  storage: Storage,
  run: WebhookRunRecord
): Promise<ExecutionRecord> {
  const execution = await storage.executions.getById({
    projectId: run.projectId,
    id: run.executionId,
  })
  if (!execution) {
    throw new WebhookRunError(
      `[Sixb] Execution '${run.executionId}' for Webhook run '${run.id}' was not found.`,
      "invalid_execution"
    )
  }
  return execution
}

function requireWebhookRunStorage(storage: Storage): NonNullable<Storage["webhookRuns"]> {
  if (!storage.webhookRuns) {
    throw new WebhookRunError("[Sixb] Webhook run storage is not configured.")
  }
  return storage.webhookRuns
}

function assertAdmissionInput(input: AdmitWebhookRunInput): void {
  if (input.idempotencyKey !== undefined && !input.idempotencyKey.trim()) {
    throw new WebhookRunError("[Sixb] Webhook idempotency key must not be empty.")
  }
  if (!Number.isSafeInteger(input.requestBodyBytes) || input.requestBodyBytes < 0) {
    throw new WebhookRunError("[Sixb] Webhook request body bytes must be a non-negative integer.")
  }
  if (!/^[a-f0-9]{64}$/.test(input.requestBodySha256)) {
    throw new WebhookRunError("[Sixb] Webhook request body SHA-256 must be lowercase hexadecimal.")
  }
}

function isConcurrentAdmissionConflict(error: unknown): boolean {
  return (
    isStorageSerializationFailure(error) ||
    (error instanceof ExecutionStorageError && error.code === "duplicate_execution") ||
    (error instanceof WebhookRunError &&
      (error.code === "duplicate_run" || error.code === "invalid_transition"))
  )
}
