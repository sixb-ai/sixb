import { randomUUID } from "node:crypto"
import type { ModelCallEndEvent, ModelUsage } from "@sixb/core/models"
import type { ReadonlyJsonObject, RecordAiModelCallInput } from "@sixb/core/storage"
import { normalizeAiModelCallRecord } from "@sixb/core/storage"
import { AgentUsageRecordingError } from "./errors"
import { aiModelCallUsageFromModel } from "./model-adapters"
import { recordAiModelCallAccounting } from "./model-call-accounting"
import { isPermanentAiUsageRecoveryError } from "./model-call-recovery"
import type { AgentWorkerStorage, RecoverAiModelCall, RecoverAiModelCallInput } from "./types"

const STORAGE_RETRY_DELAYS_MS = [50, 200, 600] as const

export interface AiModelCallRecorderInput {
  readonly storage: AgentWorkerStorage
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
  readonly recordAccounting?: (input: RecoverAiModelCallInput) => Promise<void>
}

/** Persist every completed provider call before another billable loop step can start. */
export class AiModelCallRecorder {
  private readonly generateId: () => string
  private readonly now: () => Date
  private readonly retryDelaysMs: readonly number[]
  private readonly sleep: (ms: number) => Promise<void>
  private readonly recordAccounting: (input: RecoverAiModelCallInput) => Promise<void>
  private recordingError: AgentUsageRecordingError | undefined

  constructor(
    private readonly input: AiModelCallRecorderInput,
    internals: AiModelCallRecorderInternals = {}
  ) {
    this.generateId = internals.generateId ?? (() => `ai_usage_${randomUUID()}`)
    this.now = internals.now ?? (() => new Date())
    this.retryDelaysMs = internals.retryDelaysMs ?? STORAGE_RETRY_DELAYS_MS
    this.sleep = internals.sleep ?? sleep
    this.recordAccounting =
      internals.recordAccounting ??
      (async (recovery) => {
        await recordAiModelCallAccounting({ storage: this.input.storage, ...recovery })
      })
  }

  readonly onModelCallEnd = async (event: ModelCallEndEvent): Promise<void> => {
    if (this.recordingError) throw this.recordingError

    try {
      const occurredAt = this.now()
      const record: RecordAiModelCallInput = {
        id: this.generateId(),
        projectId: this.input.projectId,
        executionId: this.input.executionId,
        attempt: this.input.attempt,
        callId: event.callId,
        requesterGroupIds: this.input.requesterGroupIds,
        providerId: event.providerId,
        requestedModelId: event.modelId,
        ...(event.requestedReasoning === undefined
          ? {}
          : { requestedReasoning: event.requestedReasoning }),
        ...(event.responseModelId === undefined ? {} : { responseModelId: event.responseModelId }),
        responseId: event.responseId,
        usage: aiModelCallUsageFromModel(event.usage),
        ...(event.usage.raw === undefined ? {} : { rawUsage: rawUsage(event.usage) }),
        occurredAt,
      }
      normalizeAiModelCallRecord(record)
      const recoveryInput: RecoverAiModelCallInput = {
        usage: record,
        cost: event.cost,
        ...(event.route === undefined ? {} : { route: event.route }),
        ratedAt: new Date(occurredAt),
      }

      try {
        await retryOperation(
          () => this.recordAccounting(recoveryInput),
          this.retryDelaysMs,
          this.sleep,
          (error) => !isPermanentAiUsageRecoveryError(error)
        )
      } catch (storageError) {
        if (isPermanentAiUsageRecoveryError(storageError)) throw storageError

        try {
          await retryOperation(
            () => this.input.recoverAiModelCall(recoveryInput),
            this.retryDelaysMs,
            this.sleep,
            (error) => !isPermanentAiUsageRecoveryError(error)
          )
        } catch (recoveryError) {
          throw new AggregateError(
            [storageError, recoveryError],
            "Direct AI accounting and durable recovery both failed."
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

function rawUsage(usage: ModelUsage): ReadonlyJsonObject {
  return structuredClone(usage.raw ?? {}) as ReadonlyJsonObject
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
