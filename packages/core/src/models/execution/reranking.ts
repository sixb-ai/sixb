import { randomUUID } from "node:crypto"
import type { RerankingModelCatalog } from "../catalog"
import { indexModelBindings } from "../catalog-index"
import { estimateModelCall } from "../pricing"
import {
  assertRerankingModel,
  type RerankingModel,
  type RerankingModelRequest,
  RerankingModelResponseError,
  type RerankingModelResponseMetadata,
  type RerankingModelResult,
  validateRerankingResults,
} from "../reranking-model"
import type { AiModelCallRecorder } from "./model-call-recorder"
import type { ModelExecutionSession } from "./session"

export function bindRerankingModels(
  catalog: RerankingModelCatalog | undefined,
  session: ModelExecutionSession
): RerankingModelCatalog | undefined {
  if (!catalog) return undefined
  return indexModelBindings(
    catalog.list().map(({ model }) =>
      Object.freeze({
        providerId: model.providerId,
        modelId: model.modelId,
        definition: model.definition,
        rerank: (input: RerankingModelRequest) => executeReranking(session, model, input),
      })
    ),
    "reranking",
    assertRerankingModel
  )
}

async function executeReranking(
  session: ModelExecutionSession,
  binding: RerankingModel,
  input: RerankingModelRequest
): Promise<RerankingModelResult> {
  const query = input.query
  if (
    typeof query !== "string" ||
    !query.trim() ||
    !Array.isArray(input.documents) ||
    input.documents.some((text) => typeof text !== "string" || !text.trim())
  ) {
    throw new TypeError("[SixbModels] Reranking requires a query and nonempty document strings.")
  }
  const documents = [...input.documents]
  const signal = AbortSignal.any([session.signal(input.signal), AbortSignal.timeout(30_000)])
  signal.throwIfAborted()
  if (documents.length === 0) return { results: [] }

  const accounting = await session.accounting()
  accounting.assertHealthy()
  const model = (await binding.resolve?.()) ?? binding
  assertRerankingModel(model)
  if (model.providerId !== binding.providerId || model.modelId !== binding.modelId) {
    throw new TypeError(
      "[SixbModels] Resolved reranking model identity does not match its binding."
    )
  }
  signal.throwIfAborted()

  // Rerankers compare each document with the query. Count the query for each pair;
  // this is the shared admission heuristic, never a substitute for reported usage.
  const encoder = new TextEncoder()
  const queryBytes = encoder.encode(query).byteLength
  const tokens = documents.reduce(
    (sum, text) => sum + Math.ceil((queryBytes + encoder.encode(text).byteLength) / 4),
    0
  )
  const callId = `call_${randomUUID()}`
  await accounting.admitCall({
    callId,
    providerId: model.providerId,
    modelId: model.modelId,
    costEstimator: model.costEstimator,
    inputTokens: { status: "estimated", tokens, method: "utf8BytesDividedByFour" },
    outputTokenAllowance: 0,
    estimatedTotalTokens: tokens,
  })

  let result: RerankingModelResult
  try {
    signal.throwIfAborted()
    result = await model.rerank({ query, documents, signal })
  } catch (error) {
    const metadata = error instanceof RerankingModelResponseError ? error.metadata : {}
    await recordReranking(accounting, model, callId, metadata)
    throw error
  }

  // A malformed or cancelled response can still be billable.
  await recordReranking(accounting, model, callId, result ?? {})
  signal.throwIfAborted()
  try {
    return { ...result, results: validateRerankingResults(result?.results, documents.length) }
  } catch (cause) {
    throw new RerankingModelResponseError(
      "[SixbModels] Invalid reranking response.",
      model.providerId,
      model.modelId,
      result ?? {},
      { cause }
    )
  }
}

async function recordReranking(
  accounting: AiModelCallRecorder,
  model: RerankingModel,
  callId: string,
  metadata: RerankingModelResponseMetadata
): Promise<void> {
  const usage = { ...metadata.usage, outputTokens: metadata.usage?.outputTokens ?? 0 }
  const estimate = estimateModelCall(model, {
    usage,
    route: metadata.route,
    responseModelId: metadata.responseModelId,
  })
  await accounting.onModelCallEnd({
    callId,
    modelKind: "reranking",
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
