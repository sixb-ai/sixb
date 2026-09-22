import { randomUUID } from "node:crypto"
import type { EmbeddingModelCatalog, EmbeddingModelEntry, ModelRef } from "../catalog"
import {
  assertEmbeddingModel,
  type EmbeddingModel,
  type EmbeddingModelRequest,
  EmbeddingModelResponseError,
  type EmbeddingModelResponseMetadata,
  type EmbeddingModelResult,
  sameEmbeddingModel,
} from "../embedding-model"
import { estimateModelCall } from "../pricing"
import type { AiModelCallRecorder } from "./model-call-recorder"
import type { ModelExecutionSession } from "./session"

/** Scope the configured bindings without changing profile identity or object permissions. */
export function bindEmbeddingModels(
  catalog: EmbeddingModelCatalog | undefined,
  session: ModelExecutionSession
): EmbeddingModelCatalog | undefined {
  if (!catalog) return undefined
  const entries: readonly EmbeddingModelEntry[] = Object.freeze(
    catalog.list().map((entry) =>
      Object.freeze({
        ...entry,
        model: Object.freeze({
          providerId: entry.model.providerId,
          modelId: entry.model.modelId,
          definition: entry.model.definition,
          batching: entry.model.batching && Object.freeze({ ...entry.model.batching }),
          embed: (input: EmbeddingModelRequest) => executeEmbedding(session, entry.model, input),
        }),
      })
    )
  )
  const byRef = new Map(
    entries.map((entry) => [JSON.stringify([entry.provider, entry.modelId]), entry])
  )
  return Object.freeze({
    list: () => entries,
    getByRef: (ref: ModelRef) => byRef.get(JSON.stringify([ref.provider, ref.modelId])) ?? null,
  })
}

async function executeEmbedding(
  session: ModelExecutionSession,
  binding: EmbeddingModel,
  input: EmbeddingModelRequest
) {
  if (
    !Array.isArray(input.texts) ||
    input.texts.some((text) => typeof text !== "string" || !text.trim())
  ) {
    throw new TypeError("[SixbModels] Embedding inputs must be nonempty strings.")
  }
  const texts = [...input.texts]
  const signal = session.signal(input.signal)
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
  requestSignal.throwIfAborted()
  if (!texts.length) return { vectors: [] }

  const accounting = await session.accounting()
  accounting.assertHealthy()
  const model = (await binding.resolve?.()) ?? binding
  assertEmbeddingModel(model)
  if (!sameEmbeddingModel(model, binding)) {
    throw new TypeError(
      "[SixbModels] Resolved embedding model identity does not match the selected model."
    )
  }
  requestSignal.throwIfAborted()
  const callId = `call_${randomUUID()}`
  const tokens = texts.reduce(
    (sum, text) => sum + Math.ceil(new TextEncoder().encode(text).byteLength / 4),
    0
  )
  await session.admitEmbeddingCall(() =>
    accounting.admitCall({
      callId,
      providerId: model.providerId,
      modelId: model.modelId,
      costEstimator: model.costEstimator,
      inputTokens: { status: "estimated", tokens, method: "utf8BytesDividedByFour" },
      outputTokenAllowance: 0,
      estimatedTotalTokens: tokens,
    })
  )

  let result: EmbeddingModelResult
  try {
    requestSignal.throwIfAborted()
    result = await model.embed({ texts, signal: requestSignal })
  } catch (error) {
    if (error instanceof EmbeddingModelResponseError) {
      await recordEmbedding(accounting, model, callId, error.metadata)
    } else {
      // The provider may have accepted the request. Never retry inference or release its budget.
      await recordEmbedding(accounting, model, callId, {})
    }
    throw error
  }
  // Account before cancellation, vector validation or the materializer's optimistic write.
  await recordEmbedding(accounting, model, callId, result ?? {})
  requestSignal.throwIfAborted()
  return result
}

async function recordEmbedding(
  accounting: AiModelCallRecorder,
  model: EmbeddingModel,
  callId: string,
  metadata: EmbeddingModelResponseMetadata
): Promise<void> {
  // Embeddings produce no output tokens; missing INPUT usage must remain unknown.
  const usage = { ...metadata.usage, outputTokens: 0 }
  const estimate = estimateModelCall(model, {
    usage,
    route: metadata.route,
    responseModelId: metadata.responseModelId,
  })
  await accounting.onModelCallEnd({
    callId,
    providerId: model.providerId,
    modelId: model.modelId,
    responseId: metadata.providerIds?.responseId ?? callId,
    responseModelId: metadata.responseModelId,
    providerIds: metadata.providerIds,
    usage,
    cost: metadata.reportedCost ? { status: "reported", ...metadata.reportedCost } : estimate,
    ...(metadata.reportedCost ? { estimate } : {}),
    route: metadata.route,
  })
}
