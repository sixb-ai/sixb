import { randomUUID } from "node:crypto"
import { omitUndefinedObjectProperties } from "@sixb/core/internal/agents"
import type {
  AiPricingContext,
  ReadonlyJsonObject,
  RecordAiModelCallInput,
} from "@sixb/core/storage"
import { normalizeAiModelCallRecord } from "@sixb/core/storage"
import {
  type LanguageModelCallEndEvent,
  type LanguageModelCallStartEvent,
  wrapLanguageModel,
} from "ai"
import { recordAiModelCallAccounting } from "./ai-pricing/accounting"
import {
  aiModelCallUsageFromAiSdk,
  aiPricingContextFromAiSdkCallStart,
  aiPricingContextFromAiSdkUsage,
} from "./ai-sdk-adapters"
import { AgentUsageRecordingError } from "./errors"
import { isPermanentAiUsageRecoveryError } from "./model-call-recovery"
import type { AgentWorkerStorage, RecoverAiModelCall, RecoverAiModelCallInput } from "./types"

const STORAGE_RETRY_DELAYS_MS = [50, 200, 600] as const

export interface AiModelCallRecorderInput {
  readonly storage: AgentWorkerStorage
  readonly projectId: string
  readonly executionId: string
  readonly attempt: number
  readonly requesterGroupIds: readonly string[]
  readonly providerOptions?: unknown
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

interface ModelCallStartSnapshot {
  readonly pricingContext: AiPricingContext
}

interface ModelCallResponseSnapshot {
  readonly modelId?: string
  readonly providerMetadata?: ReadonlyJsonObject
  readonly pricingContext?: AiPricingContext
}

/**
 * Persist every completed provider call before the tool loop can begin another model step.
 *
 * Current storage records usage, allowlisted request billing context, and strict local valuation in
 * one transaction. AI SDK swallows lifecycle callback errors, so persistent failures still move to
 * durable recovery and are surfaced by `prepareStep` before another provider call.
 */
export class AiModelCallRecorder {
  private readonly generateId: () => string
  private readonly now: () => Date
  private readonly retryDelaysMs: readonly number[]
  private readonly sleep: (ms: number) => Promise<void>
  private readonly recordAccounting: (input: RecoverAiModelCallInput) => Promise<void>
  private readonly starts = new Map<string, ModelCallStartSnapshot>()
  private readonly responses = new Map<string, ModelCallResponseSnapshot>()
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
      (async (input) => {
        await recordAiModelCallAccounting({ storage: this.input.storage, ...input })
      })
  }

  readonly onLanguageModelCallStart = async (event: LanguageModelCallStartEvent): Promise<void> => {
    if (this.recordingError) return
    this.starts.set(event.callId, {
      pricingContext: aiPricingContextFromAiSdkCallStart(event, this.input.providerOptions),
    })
  }

  readonly onLanguageModelCallEnd = async (event: LanguageModelCallEndEvent): Promise<void> => {
    if (this.recordingError) return

    try {
      const response = this.responses.get(event.responseId)
      this.responses.delete(event.responseId)
      const normalizedRawUsage =
        event.usage.raw === undefined
          ? undefined
          : (omitUndefinedObjectProperties(event.usage.raw) as ReadonlyJsonObject)
      const rawUsage =
        normalizedRawUsage === undefined && response?.providerMetadata === undefined
          ? undefined
          : {
              ...(normalizedRawUsage ?? {}),
              ...(response?.providerMetadata === undefined
                ? {}
                : { providerMetadata: response.providerMetadata }),
            }
      const occurredAt = this.now()
      const start = this.starts.get(event.callId)
      this.starts.delete(event.callId)
      const responseModelId = response?.modelId
      const record: RecordAiModelCallInput = {
        id: this.generateId(),
        projectId: this.input.projectId,
        executionId: this.input.executionId,
        attempt: this.input.attempt,
        callId: event.callId,
        requesterGroupIds: this.input.requesterGroupIds,
        providerId: event.provider,
        requestedModelId: event.modelId,
        ...(responseModelId === undefined ? {} : { responseModelId }),
        responseId: event.responseId,
        usage: aiModelCallUsageFromAiSdk(event.usage),
        ...(rawUsage === undefined ? {} : { rawUsage }),
        occurredAt,
      }
      normalizeAiModelCallRecord(record)
      const recoveryInput: RecoverAiModelCallInput = {
        usage: record,
        pricingContext: aiPricingContextFromAiSdkUsage(
          { ...(start?.pricingContext ?? {}), ...(response?.pricingContext ?? {}) },
          rawUsage
        ),
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
    }
  }

  /** Capture response model identities that AI SDK lifecycle callbacks do not expose. */
  wrapModel(
    model: Parameters<typeof wrapLanguageModel>[0]["model"]
  ): ReturnType<typeof wrapLanguageModel> {
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, model, params }) => {
          const result = await doGenerate()
          this.rememberResponse(
            result.response,
            result.providerMetadata,
            aiPricingContextFromAiSdkCallStart(model, params.providerOptions)
          )
          return result
        },
        wrapStream: async ({ doStream, model, params }) => {
          const result = await doStream()
          const pricingContext = aiPricingContextFromAiSdkCallStart(model, params.providerOptions)
          let response: { readonly id?: string; readonly modelId?: string } | undefined
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream({
                transform: (part, controller) => {
                  if (part.type === "response-metadata") response = part
                  if (part.type === "finish") {
                    this.rememberResponse(response, part.providerMetadata, pricingContext)
                  }
                  controller.enqueue(part)
                },
              })
            ),
          }
        },
      },
    })
  }

  /** AI SDK invokes this before every step; a prior append failure prevents the next provider call. */
  readonly prepareStep = (): undefined => {
    this.assertHealthy()
    return undefined
  }

  assertHealthy(): void {
    if (this.recordingError) throw this.recordingError
  }

  private rememberResponse(
    response: { readonly id?: string; readonly modelId?: string } | undefined,
    providerMetadata: unknown,
    pricingContext: AiPricingContext
  ): void {
    if (!response?.id) return
    const normalizedProviderMetadata =
      providerMetadata === undefined
        ? undefined
        : (omitUndefinedObjectProperties(providerMetadata) as ReadonlyJsonObject)
    if (
      response.modelId === undefined &&
      normalizedProviderMetadata === undefined &&
      Object.keys(pricingContext).length === 0
    ) {
      return
    }
    this.responses.set(response.id, {
      ...(response.modelId === undefined ? {} : { modelId: response.modelId }),
      ...(normalizedProviderMetadata === undefined
        ? {}
        : { providerMetadata: normalizedProviderMetadata }),
      ...(Object.keys(pricingContext).length === 0 ? {} : { pricingContext }),
    })
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
