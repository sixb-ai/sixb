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
import {
  aiModelCallUsageFromAiSdk,
  aiPricingContextFromAiSdkCallStart,
  aiPricingContextFromAiSdkUsage,
} from "./ai-sdk-adapters"
import { AgentUsageRecordingError } from "./errors"
import { recordAiModelCallAccounting } from "./model-call-accounting"
import {
  type AiModelCallAdmissionDecision,
  type AiModelCallAdmissionInput,
  aiModelCallOutputTokenAllowance,
  type BeforeAiModelCall,
  estimateAiModelCallInputTokens,
  estimatedAiModelCallTotalTokens,
} from "./model-call-admission"
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
  /** Aggregate-budget admission invoked immediately before every provider request. */
  readonly beforeModelCall?: BeforeAiModelCall
  /** Moves a provider attempt with no trustworthy usage callback into conservative unknown state. */
  readonly markModelCallUnknown?: (
    input: Pick<AiModelCallAdmissionInput, "projectId" | "executionId" | "attempt" | "callId">
  ) => void | Promise<void>
  readonly recoverAiModelCall: RecoverAiModelCall
  /** Run identity used only in terminal recorder diagnostics. */
  readonly errorRunId: string
}

interface AiModelCallRecorderInternals {
  readonly generateId?: () => string
  readonly generateCallId?: () => string
  readonly now?: () => Date
  readonly retryDelaysMs?: readonly number[]
  readonly sleep?: (ms: number) => Promise<void>
  readonly recordAccounting?: (input: RecoverAiModelCallInput) => Promise<void>
}

interface ModelCallStartSnapshot {
  readonly pricingContext: AiPricingContext
}

interface ModelCallResponseSnapshot {
  readonly callId: string
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
  private readonly generateCallId: () => string
  private readonly now: () => Date
  private readonly retryDelaysMs: readonly number[]
  private readonly sleep: (ms: number) => Promise<void>
  private readonly recordAccounting: (input: RecoverAiModelCallInput) => Promise<void>
  private readonly starts = new Map<string, ModelCallStartSnapshot>()
  private readonly responses = new Map<string, ModelCallResponseSnapshot>()
  private readonly completedResponses: ModelCallResponseSnapshot[] = []
  private readonly callIds = new Set<string>()
  private readonly limitedCalls = new Map<string, AiModelCallAdmissionInput>()
  private admissionError: unknown
  private recordingError: AgentUsageRecordingError | undefined

  constructor(
    private readonly input: AiModelCallRecorderInput,
    internals: AiModelCallRecorderInternals = {}
  ) {
    this.generateId = internals.generateId ?? (() => `ai_usage_${randomUUID()}`)
    this.generateCallId = internals.generateCallId ?? (() => `ai_call_${randomUUID()}`)
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

    let callId = event.callId
    try {
      const response = this.takeCompletedResponse(event.responseId)
      callId = response?.callId ?? event.callId
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
        callId,
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
        reconcileLimitReservation: this.limitedCalls.has(callId),
      }

      try {
        await retryOperation(
          () => this.recordAccounting(recoveryInput),
          this.retryDelaysMs,
          this.sleep,
          (error) => !isPermanentAiUsageRecoveryError(error)
        )
        this.limitedCalls.delete(callId)
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
        throw new AgentUsageRecordingError(this.input.errorRunId, callId, true, {
          cause: storageError,
        })
      }
    } catch (error) {
      try {
        await this.markCallUnknown(callId)
      } catch {
        // The active reservation still holds the same capacity when the unknown transition is
        // unavailable, so admission remains fail-closed. Preserve the accounting error that stops
        // the loop and drives durable recovery.
      }
      this.recordingError =
        error instanceof AgentUsageRecordingError
          ? error
          : new AgentUsageRecordingError(this.input.errorRunId, callId, false, {
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
          const admission = await this.beforeProviderCall(model, params)
          const result = await Promise.resolve(doGenerate()).catch(async (error: unknown) => {
            await this.markCallUnknown(admission.callId)
            throw error
          })
          this.rememberResponse(
            admission.callId,
            result.response,
            result.providerMetadata,
            aiPricingContextFromAiSdkCallStart(model, params.providerOptions)
          )
          return result
        },
        wrapStream: async ({ doStream, model, params }) => {
          const admission = await this.beforeProviderCall(model, params)
          const result = await Promise.resolve(doStream()).catch(async (error: unknown) => {
            await this.markCallUnknown(admission.callId)
            throw error
          })
          const pricingContext = aiPricingContextFromAiSdkCallStart(model, params.providerOptions)
          let response: { readonly id?: string; readonly modelId?: string } | undefined
          let finished = false
          return {
            ...result,
            stream: result.stream.pipeThrough(
              new TransformStream({
                transform: async (part, controller) => {
                  if (part.type === "response-metadata") response = part
                  if (part.type === "finish") {
                    finished = true
                    this.rememberResponse(
                      admission.callId,
                      response,
                      part.providerMetadata,
                      pricingContext
                    )
                  }
                  if (part.type === "error") await this.markCallUnknown(admission.callId)
                  controller.enqueue(part)
                },
                flush: async () => {
                  if (!finished) await this.markCallUnknown(admission.callId)
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
    if (this.admissionError !== undefined) throw this.admissionError
    if (this.recordingError) throw this.recordingError
  }

  private rememberResponse(
    callId: string,
    response: { readonly id?: string; readonly modelId?: string } | undefined,
    providerMetadata: unknown,
    pricingContext: AiPricingContext
  ): void {
    const normalizedProviderMetadata =
      providerMetadata === undefined
        ? undefined
        : (omitUndefinedObjectProperties(providerMetadata) as ReadonlyJsonObject)
    const snapshot: ModelCallResponseSnapshot = {
      callId,
      ...(response?.modelId === undefined ? {} : { modelId: response.modelId }),
      ...(normalizedProviderMetadata === undefined
        ? {}
        : { providerMetadata: normalizedProviderMetadata }),
      ...(Object.keys(pricingContext).length === 0 ? {} : { pricingContext }),
    }
    this.completedResponses.push(snapshot)
    if (response?.id) this.responses.set(response.id, snapshot)
  }

  private takeCompletedResponse(responseId: string): ModelCallResponseSnapshot | undefined {
    const indexed = this.responses.get(responseId)
    const index = indexed === undefined ? 0 : this.completedResponses.indexOf(indexed)
    if (index < 0 || index >= this.completedResponses.length) return indexed
    const [response] = this.completedResponses.splice(index, 1)
    // Keep the resolved response-to-call mapping for this recorder's bounded lifetime. AI SDK may
    // replay a lifecycle callback; forgetting the mapping would fall back to its different call ID
    // and defeat the usage ledger's idempotency key.
    if (response && indexed === undefined) this.responses.set(responseId, response)
    return response ?? indexed
  }

  private async beforeProviderCall(
    model: { readonly provider: string; readonly modelId: string },
    params: {
      readonly prompt: unknown
      readonly tools?: unknown
      readonly responseFormat?: unknown
      readonly maxOutputTokens?: number
      readonly providerOptions?: unknown
    }
  ): Promise<AiModelCallAdmissionInput> {
    this.assertHealthy()
    const callId = this.generateCallId()
    if (!callId.trim() || this.callIds.has(callId)) {
      throw new Error("[SixbAgentWorker] AI model-call IDs must be nonempty and unique.")
    }
    this.callIds.add(callId)

    const inputTokens = estimateAiModelCallInputTokens({
      prompt: params.prompt,
      tools: params.tools,
      responseFormat: params.responseFormat,
    })
    const outputTokenAllowance = aiModelCallOutputTokenAllowance(params.maxOutputTokens)
    const estimatedTotalTokens = estimatedAiModelCallTotalTokens(inputTokens, outputTokenAllowance)
    const admission: AiModelCallAdmissionInput = {
      projectId: this.input.projectId,
      executionId: this.input.executionId,
      attempt: this.input.attempt,
      requesterGroupIds: [...this.input.requesterGroupIds],
      callId,
      providerId: model.provider,
      modelId: model.modelId,
      pricingContext: aiPricingContextFromAiSdkCallStart(model, params.providerOptions),
      inputTokens,
      outputTokenAllowance,
      ...(estimatedTotalTokens === undefined ? {} : { estimatedTotalTokens }),
    }
    let decision: AiModelCallAdmissionDecision
    try {
      decision = this.input.beforeModelCall
        ? await this.input.beforeModelCall(admission)
        : { reservation: "none" as const }
    } catch (error) {
      // Streaming SDKs may turn middleware errors into stream error parts. Retain the exact coded
      // admission rejection so the run terminal boundary cannot collapse it into a generic model
      // failure after the stream drains.
      this.admissionError = error
      throw error
    }
    if (decision.reservation === "active") this.limitedCalls.set(callId, admission)
    return admission
  }

  private async markCallUnknown(callId: string): Promise<void> {
    const admission = this.limitedCalls.get(callId)
    if (!admission) return
    await this.input.markModelCallUnknown?.({
      projectId: admission.projectId,
      executionId: admission.executionId,
      attempt: admission.attempt,
      callId: admission.callId,
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
