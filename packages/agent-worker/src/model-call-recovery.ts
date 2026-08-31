import { createSixbError } from "@sixb/core/internal/errors"
import type {
  AgentAiUsageRecordPayload,
  AgentAiUsageRecordRequestedQueueJob,
  AgentQueueJob,
  Queue,
} from "@sixb/core/queues"
import type {
  AiModelCallUsageInput,
  AiUsageStorage,
  RecordAiModelCallInput,
  RecordAiModelCallResult,
} from "@sixb/core/storage"
import { AiUsageStorageError, normalizeAiModelCallRecord } from "@sixb/core/storage"

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

/** Hand one failed ledger append to the durable agent lane without serializing Date objects. */
export async function enqueueAiModelCallRecovery(
  queue: Pick<Queue<AgentQueueJob>, "enqueue">,
  record: RecordAiModelCallInput
): Promise<void> {
  normalizeAiModelCallRecord(record)
  const jobId = agentAiUsageRecoveryJobId(record.id)
  const [job] = await queue.enqueue({
    projectId: record.projectId,
    jobs: [
      {
        id: jobId,
        type: "agent.ai-usage.record.requested",
        payload: { record: toQueuePayload(record) },
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

/** Replay one durable handoff through the idempotent model-call ledger boundary. */
export async function recordRecoveredAiModelCall(
  storage: AiUsageStorage,
  job: AgentAiUsageRecordRequestedQueueJob
): Promise<RecordAiModelCallResult> {
  return storage.recordModelCall(fromQueuePayload(job))
}

/** Validation and referential-integrity failures cannot become valid through queue redelivery. */
export function isPermanentAiUsageRecoveryError(error: unknown): boolean {
  return (
    error instanceof InvalidAiUsageRecoveryJobError ||
    error instanceof TypeError ||
    (error instanceof AiUsageStorageError &&
      (error.code === "duplicate_id" || error.code === "missing_execution"))
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
    requestedModelId: record.requestedModelId,
    ...(record.responseModelId === undefined ? {} : { responseModelId: record.responseModelId }),
    responseId: record.responseId,
    usage: toQueueUsage(record.usage),
    ...(record.modelDefinition === undefined
      ? {}
      : {
          modelDefinition: structuredClone(
            record.modelDefinition
          ) as AgentAiUsageRecordPayload["modelDefinition"],
        }),
    ...(record.cost === undefined
      ? {}
      : { cost: structuredClone(record.cost) as AgentAiUsageRecordPayload["cost"] }),
    ...(record.route === undefined
      ? {}
      : { route: structuredClone(record.route) as AgentAiUsageRecordPayload["route"] }),
    ...(record.rawUsage === undefined ? {} : { rawUsage: structuredClone(record.rawUsage) }),
    occurredAt: record.occurredAt.toISOString(),
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
  const occurredAt = new Date(job.payload.record.occurredAt)
  if (!Number.isFinite(occurredAt.getTime())) {
    throw new InvalidAiUsageRecoveryJobError(
      `AI usage recovery job '${job.id}' has an invalid occurredAt timestamp.`
    )
  }

  const { modelDefinition, cost, route, ...record } = job.payload.record
  return {
    ...record,
    projectId: job.projectId,
    ...(modelDefinition === undefined
      ? {}
      : {
          modelDefinition: structuredClone(
            modelDefinition
          ) as RecordAiModelCallInput["modelDefinition"],
        }),
    ...(cost === undefined
      ? {}
      : { cost: structuredClone(cost) as RecordAiModelCallInput["cost"] }),
    ...(route === undefined
      ? {}
      : { route: structuredClone(route) as RecordAiModelCallInput["route"] }),
    occurredAt,
  }
}
