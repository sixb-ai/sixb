import { randomUUID } from "node:crypto"
import { omitUndefinedObjectProperties } from "@sixb/core/internal/agents"
import type {
  AiUsageExecutionIdentity,
  AiUsageStorage,
  ReadonlyJsonObject,
  RecordAiModelCallInput,
} from "@sixb/core/storage"
import type { LanguageModelCallEndEvent } from "ai"
import { aiModelCallUsageFromAiSdk } from "./ai-sdk-adapters"
import { AgentUsageRecordingError } from "./errors"

const STORAGE_RETRY_DELAYS_MS = [50, 200, 600] as const

export interface AiModelCallRecorderInput {
  readonly storage: AiUsageStorage
  readonly projectId: string
  readonly execution: AiUsageExecutionIdentity
  readonly attempt: number
  readonly requesterPrincipal: RecordAiModelCallInput["requesterPrincipal"]
  readonly requesterGroupIds: readonly string[]
  /** Run identity used only to report recorder and terminal-summary failures. */
  readonly errorRunId: string
}

interface AiModelCallRecorderInternals {
  readonly generateId?: () => string
  readonly now?: () => Date
  readonly retryDelaysMs?: readonly number[]
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * Persist every completed AI SDK provider call before the tool loop can begin another model step.
 *
 * AI SDK deliberately swallows lifecycle callback errors. This recorder therefore retains a
 * terminal append failure and exposes `prepareStep`, which throws it before another provider call.
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

  readonly onLanguageModelCallEnd = async (event: LanguageModelCallEndEvent): Promise<void> => {
    if (this.recordingError) return

    try {
      // AI SDK's JSONObject permits optional object properties with `undefined`; omission is the
      // canonical JSON representation of those properties. Storage still validates the result.
      const rawUsage =
        event.usage.raw === undefined
          ? undefined
          : (omitUndefinedObjectProperties(event.usage.raw) as ReadonlyJsonObject)
      const record: RecordAiModelCallInput = {
        id: this.generateId(),
        projectId: this.input.projectId,
        execution: this.input.execution,
        attempt: this.input.attempt,
        callId: event.callId,
        requesterPrincipal: this.input.requesterPrincipal,
        requesterGroupIds: this.input.requesterGroupIds,
        providerId: event.provider,
        requestedModelId: event.modelId,
        responseId: event.responseId,
        usage: aiModelCallUsageFromAiSdk(event.usage),
        ...(rawUsage === undefined ? {} : { rawUsage }),
        occurredAt: this.now(),
      }

      await retryStorageOperation(
        () => this.input.storage.recordModelCall(record),
        this.retryDelaysMs,
        this.sleep
      )
    } catch (error) {
      this.recordingError = new AgentUsageRecordingError(this.input.errorRunId, event.callId, {
        cause: error,
      })
    }
  }

  /** AI SDK invokes this before every step; a prior append failure prevents the next provider call. */
  readonly prepareStep = (): undefined => {
    this.assertHealthy()
    return undefined
  }

  assertHealthy(): void {
    if (this.recordingError) throw this.recordingError
  }
}

async function retryStorageOperation<TResult>(
  operation: () => Promise<TResult>,
  retryDelaysMs: readonly number[],
  wait: (ms: number) => Promise<void>
): Promise<TResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const delay = retryDelaysMs[attempt]
      if (delay === undefined) throw error
      await wait(delay)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
