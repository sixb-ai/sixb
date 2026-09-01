import { createSixbError } from "@sixb/core/internal/errors"
import { isJsonObject } from "@sixb/core/models"
import type {
  AgentAiUsageAccountingPayload,
  AgentAiUsageRecordPayload,
  AgentAiUsageRecordRequestedQueueJob,
  AgentQueueJob,
  Queue,
} from "@sixb/core/queues"
import type {
  AiModelCallUsageInput,
  RecordAiModelCallInput,
  RecordAiModelCallResult,
} from "@sixb/core/storage"
import {
  AiCostStorageError,
  AiLimitStorageError,
  AiUsageStorageError,
  normalizeAiModelCallRecord,
} from "@sixb/core/storage"
import { recordAiModelCallAccounting } from "./model-call-accounting"
import type { AgentWorkerStorage, RecoverAiModelCallInput } from "./types"

const AGENT_AI_USAGE_RECOVERY_JOB_PREFIX = "agt_usage_job_"

class InvalidAiUsageRecoveryJobError extends Error {
  readonly name = "InvalidAiUsageRecoveryJobError"

  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbAgentWorker] ${message}`, options)
  }
}

/** Stable queue identity: a lost enqueue response can safely retry the same accounting handoff. */
export function agentAiUsageRecoveryJobId(recordId: string): string {
  return `${AGENT_AI_USAGE_RECOVERY_JOB_PREFIX}${recordId}`
}

/** Hand one failed accounting transaction to the durable lane using only JSON-safe values. */
export async function enqueueAiModelCallRecovery(
  queue: Pick<Queue<AgentQueueJob>, "enqueue">,
  input: RecoverAiModelCallInput | RecordAiModelCallInput
): Promise<void> {
  const recovery = isRecoveryInput(input) ? input : undefined
  const record: RecordAiModelCallInput =
    recovery === undefined ? (input as RecordAiModelCallInput) : recovery.usage
  normalizeAiModelCallRecord(record)
  const jobId = agentAiUsageRecoveryJobId(record.id)
  const [job] = await queue.enqueue({
    projectId: record.projectId,
    jobs: [
      {
        id: jobId,
        type: "agent.ai-usage.record.requested",
        payload: {
          record: toQueuePayload(record),
          ...(recovery === undefined ? {} : { accounting: toAccountingPayload(recovery) }),
        },
      },
    ],
  })

  if (job?.id !== jobId || job.type !== "agent.ai-usage.record.requested") {
    throw createSixbError(
      "internal.unexpected",
      `[SixbAgentWorker] Agent queue did not confirm AI usage recovery job '${jobId}'.`,
      { details: { jobId } }
    )
  }
}

/** Replay one durable handoff through the idempotent atomic accounting boundary. */
export async function recordRecoveredAiModelCall(
  storage: AgentWorkerStorage,
  job: AgentAiUsageRecordRequestedQueueJob
): Promise<RecordAiModelCallResult> {
  const usage = fromQueuePayload(job)
  const accounting = accountingFromQueuePayload(job)
  if (accounting) return recordAiModelCallAccounting({ storage, usage, ...accounting })
  return storage.transaction(async (tx) => {
    if (!tx.aiUsage || !tx.aiLimits)
      throw new Error("[SixbAgentWorker] Recovery requires usage and limit storage.")
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

function toQueuePayload(record: RecordAiModelCallInput): AgentAiUsageRecordPayload {
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
    usage: toQueueUsage(record.usage),
    ...(record.rawUsage === undefined ? {} : { rawUsage: structuredClone(record.rawUsage) }),
    occurredAt: record.occurredAt.toISOString(),
  }
}

function toAccountingPayload(input: RecoverAiModelCallInput): AgentAiUsageAccountingPayload {
  return {
    cost: structuredClone(input.cost),
    ...(input.estimate === undefined ? {} : { estimate: structuredClone(input.estimate) }),
    ...(input.route === undefined ? {} : { route: structuredClone(input.route) }),
    ratedAt: input.ratedAt.toISOString(),
    ...(input.reconcileLimitReservation ? { reconcileLimitReservation: true } : {}),
  }
}

function toQueueUsage(usage: AiModelCallUsageInput): AgentAiUsageRecordPayload["usage"] {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: usage.uncachedInputTokens }),
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage.textOutputTokens === undefined ? {} : { textOutputTokens: usage.textOutputTokens }),
    ...(usage.reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens: usage.reasoningOutputTokens }),
  }
}

function fromQueuePayload(job: AgentAiUsageRecordRequestedQueueJob): RecordAiModelCallInput {
  const occurredAt = parseDate(job.payload.record.occurredAt, job.id, "occurredAt")
  return { ...job.payload.record, projectId: job.projectId, occurredAt }
}

function accountingFromQueuePayload(
  job: AgentAiUsageRecordRequestedQueueJob
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

function isRecoveryInput(
  input: RecoverAiModelCallInput | RecordAiModelCallInput
): input is RecoverAiModelCallInput {
  return !("id" in input)
}
