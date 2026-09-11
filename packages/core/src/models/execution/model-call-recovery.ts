import { isJsonObject } from "../../json"
import type { RecordAiModelCallInput, RecordAiModelCallResult } from "../../storage"
import {
  AiCostStorageError,
  AiLimitStorageError,
  AiUsageStorageError,
  normalizeAiModelCallRecord,
} from "../../storage"
import { recordAiModelCallAccounting } from "./model-call-accounting"
import type {
  AiModelCallAccountingPayload,
  AiModelCallRecordPayload,
  AiModelCallRecoveryRecord,
  ModelCallAccountingStorage,
  RecoverAiModelCallInput,
} from "./types"
import { aiModelCallUsageFromModel } from "./usage"

class InvalidAiUsageRecoveryJobError extends Error {
  readonly name = "InvalidAiUsageRecoveryJobError"

  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbModels] ${message}`, options)
  }
}

/** Encode one failed accounting transaction for a durable, JSON-safe handoff. */
export function modelCallRecoveryPayload(input: RecoverAiModelCallInput): {
  readonly record: AiModelCallRecordPayload
  readonly accounting: AiModelCallAccountingPayload
} {
  normalizeAiModelCallRecord(input.usage)
  return {
    record: toQueuePayload(input.usage),
    accounting: toAccountingPayload(input),
  }
}

/** Replay one durable handoff through the idempotent atomic accounting boundary. */
export async function recordRecoveredAiModelCall(
  storage: Pick<ModelCallAccountingStorage, "transaction">,
  job: AiModelCallRecoveryRecord
): Promise<RecordAiModelCallResult> {
  const usage = fromQueuePayload(job)
  const accounting = accountingFromQueuePayload(job)
  if (accounting) return recordAiModelCallAccounting({ storage, usage, ...accounting })
  return storage.transaction(async (tx) => {
    if (!tx.aiUsage || !tx.aiLimits)
      throw new Error("[SixbModels] Recovery requires usage and limit storage.")
    const result = await tx.aiUsage.recordModelCall(usage)
    if (result.created)
      await tx.aiLimits.recordModelCallActuals({
        projectId: result.record.projectId,
        usageRecordId: result.record.id,
      })
    if (job.payload.accounting?.reconcileLimitReservation)
      await tx.aiLimits.reconcileModelCall({
        projectId: result.record.projectId,
        executionId: result.record.executionId,
        attempt: result.record.attempt,
        callId: result.record.callId,
        usageRecordId: result.record.id,
      })
    return result
  })
}

/** Validation and referential-integrity failures cannot become valid through queue redelivery. */
export function isPermanentAiUsageRecoveryError(error: unknown): boolean {
  return (
    error instanceof InvalidAiUsageRecoveryJobError ||
    error instanceof TypeError ||
    (error instanceof AiUsageStorageError &&
      (error.code === "duplicate_id" || error.code === "missing_execution")) ||
    (error instanceof AiCostStorageError &&
      (error.code === "missing_usage" || error.code === "cost_mismatch")) ||
    (error instanceof AiLimitStorageError &&
      (error.code === "missing_execution" ||
        error.code === "missing_reservation" ||
        error.code === "missing_usage_record" ||
        error.code === "usage_mismatch" ||
        error.code === "reservation_conflict" ||
        error.code === "reconciliation_conflict" ||
        error.code === "invalid_reservation_state"))
  )
}

function toQueuePayload(record: RecordAiModelCallInput): AiModelCallRecordPayload {
  return {
    id: record.id,
    executionId: record.executionId,
    attempt: record.attempt,
    callId: record.callId,
    requesterGroupIds: [...record.requesterGroupIds],
    providerId: record.providerId,
    ...(record.providerIds === undefined
      ? {}
      : { providerIds: structuredClone(record.providerIds) }),
    requestedModelId: record.requestedModelId,
    ...(record.requestedReasoning === undefined
      ? {}
      : { requestedReasoning: structuredClone(record.requestedReasoning) }),
    ...(record.responseModelId === undefined ? {} : { responseModelId: record.responseModelId }),
    responseId: record.responseId,
    usage: aiModelCallUsageFromModel(record.usage),
    ...(record.rawUsage === undefined ? {} : { rawUsage: structuredClone(record.rawUsage) }),
    occurredAt: record.occurredAt.toISOString(),
  }
}

function toAccountingPayload(input: RecoverAiModelCallInput): AiModelCallAccountingPayload {
  return {
    cost: structuredClone(input.cost),
    ...(input.estimate === undefined ? {} : { estimate: structuredClone(input.estimate) }),
    ...(input.route === undefined ? {} : { route: structuredClone(input.route) }),
    ratedAt: input.ratedAt.toISOString(),
    ...(input.reconcileLimitReservation ? { reconcileLimitReservation: true } : {}),
  }
}

function fromQueuePayload(job: AiModelCallRecoveryRecord): RecordAiModelCallInput {
  const occurredAt = parseDate(job.payload.record.occurredAt, job.id, "occurredAt")
  return { ...job.payload.record, projectId: job.projectId, occurredAt }
}

function accountingFromQueuePayload(
  job: AiModelCallRecoveryRecord
): Omit<RecoverAiModelCallInput, "usage"> | undefined {
  const accounting = job.payload.accounting
  if (!accounting) return undefined
  // Older workers captured a pricing context, not a completed-call valuation. Preserve their
  // usage without inventing a historical price from today's catalog.
  if (
    !Object.hasOwn(accounting, "cost") &&
    "pricingContext" in accounting &&
    isJsonObject(accounting.pricingContext)
  ) {
    return undefined
  }
  return {
    cost: structuredClone(accounting.cost),
    ...(accounting.estimate === undefined
      ? {}
      : { estimate: structuredClone(accounting.estimate) }),
    ...(accounting.route === undefined ? {} : { route: structuredClone(accounting.route) }),
    ratedAt: parseDate(accounting.ratedAt, job.id, "ratedAt"),
    reconcileLimitReservation: accounting.reconcileLimitReservation === true,
  }
}

function parseDate(value: string, jobId: string, field: string): Date {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) {
    throw new InvalidAiUsageRecoveryJobError(
      `AI usage recovery job '${jobId}' has an invalid ${field} timestamp.`
    )
  }
  return date
}
