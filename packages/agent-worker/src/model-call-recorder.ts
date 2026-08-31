import { randomUUID } from "node:crypto"
import { omitUndefinedObjectProperties } from "@sixb/core/internal/agents"
import type { AiUsageStorage, ReadonlyJsonObject, RecordAiModelCallInput } from "@sixb/core/storage"
import { normalizeAiModelCallRecord } from "@sixb/core/storage"
import type { ModelCallEndEvent } from "@sixb/llm"
import { AgentUsageRecordingError } from "./errors"
import { aiModelCallUsageFromModel } from "./model-adapters"
import { isPermanentAiUsageRecoveryError } from "./model-call-recovery"
import type { RecoverAiModelCall } from "./types"

const STORAGE_RETRY_DELAYS_MS = [50, 200, 600] as const

export interface AiModelCallRecorderInput {
  readonly storage: AiUsageStorage
  readonly projectId: string
  readonly executionId: string
  readonly attempt: number
  readonly requesterGroupIds: readonly string[]
  readonly recoverAiModelCall: RecoverAiModelCall
  /** Run identity used only in terminal recorder diagnostics. */
  readonly errorRunId: string
}

interface AiModelCallRecorderInternals {
  readonly generateId?: () => string
  readonly now?: () => Date
  readonly retryDelaysMs?: readonly number[]
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Persist every completed provider call before the owned loop can begin another model step.
 * Callback failures propagate through the loop, so unaccounted spend fails closed immediately.
 */
export class AiModelCallRecorder {
  private readonly generateId: () => string
  private readonly now: () => Date
  private readonly retryDelaysMs: readonly number[]
  private readonly sleep: (ms: number) => Promise<void>
  private recordingError: AgentUsageRecordingError | undefined

  constructor(
    private readonly input: AiModelCallRecorderInput,
    internals: AiModelCallRecorderInternals = {}
  ) {
    this.generateId = internals.generateId ?? (() => `ai_usage_${randomUUID()}`)
    this.now = internals.now ?? (() => new Date())
    this.retryDelaysMs = internals.retryDelaysMs ?? STORAGE_RETRY_DELAYS_MS
    this.sleep = internals.sleep ?? sleep
  }

  readonly onModelCallEnd = async (event: ModelCallEndEvent): Promise<void> => {
    if (this.recordingError) throw this.recordingError

    try {
      const rawUsage =
        event.usage.raw === undefined
          ? undefined
          : (omitUndefinedObjectProperties(event.usage.raw) as ReadonlyJsonObject)
      const record: RecordAiModelCallInput = {
        id: this.generateId(),
        projectId: this.input.projectId,
        executionId: this.input.executionId,
        attempt: this.input.attempt,
        callId: event.callId,
        requesterGroupIds: this.input.requesterGroupIds,
        providerId: event.providerId,
        requestedModelId: event.modelId,
        ...(event.responseModelId === undefined ? {} : { responseModelId: event.responseModelId }),
        responseId: event.responseId,
        usage: aiModelCallUsageFromModel(event.usage),
        ...(rawUsage === undefined ? {} : { rawUsage }),
        occurredAt: this.now(),
      }
      // Reject malformed provider data before retrying storage or handing a poison record to
      // the durable queue. The storage boundary repeats this validation defensively.
      normalizeAiModelCallRecord(record)

      try {
        await retryOperation(
          () => this.input.storage.recordModelCall(record),
          this.retryDelaysMs,
          this.sleep,
          (error) => !isPermanentAiUsageRecoveryError(error)
        )
      } catch (storageError) {
        if (isPermanentAiUsageRecoveryError(storageError)) throw storageError

        try {
          await retryOperation(
            () => this.input.recoverAiModelCall(record),
            this.retryDelaysMs,
            this.sleep,
            (error) => !isPermanentAiUsageRecoveryError(error)
          )
        } catch (recoveryError) {
          throw new AggregateError(
            [storageError, recoveryError],
            "Direct AI usage recording and durable recovery both failed."
          )
        }
        throw new AgentUsageRecordingError(this.input.errorRunId, event.callId, true, {
          cause: storageError,
        })
      }
    } catch (error) {
      this.recordingError =
        error instanceof AgentUsageRecordingError
          ? error
          : new AgentUsageRecordingError(this.input.errorRunId, event.callId, false, {
              cause: error,
            })
      throw this.recordingError
    }
  }

  assertHealthy(): void {
    if (this.recordingError) throw this.recordingError
  }
}

async function retryOperation<TResult>(
  operation: () => Promise<TResult>,
  retryDelaysMs: readonly number[],
  wait: (ms: number) => Promise<void>,
  shouldRetry: (error: unknown) => boolean
): Promise<TResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!shouldRetry(error)) throw error
      const delay = retryDelaysMs[attempt]
      if (delay === undefined) throw error
      await wait(delay)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
