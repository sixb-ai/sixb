import type { ModelDefinition } from "./definitions"
import { ModelProviderError } from "./errors"
import type { ModelProviderIds, ModelRoute, ModelUsage } from "./events"
import type { ModelCostEstimator, ModelReportedCost } from "./pricing"

export interface RerankingModelDefinition extends ModelDefinition {
  readonly kind: "reranking"
}

/** Serializable identity; the server resolves its own registered binding. */
export interface RerankingModelRef {
  readonly providerId: string
  readonly modelId: string
  readonly definition: RerankingModelDefinition
}

export interface RerankingModelRequest {
  readonly query: string
  readonly documents: readonly string[]
  readonly signal?: AbortSignal
}

export interface RerankingModelResponseMetadata {
  readonly usage?: ModelUsage
  readonly providerIds?: ModelProviderIds
  readonly responseModelId?: string
  readonly reportedCost?: ModelReportedCost
  readonly route?: ModelRoute
}

export interface RerankingResult {
  /** Position in the original documents array. */
  readonly index: number
  /** Provider relevance score, not a calibrated probability. */
  readonly score: number
}

export interface RerankingModelResult extends RerankingModelResponseMetadata {
  /** One result per input document; Sixb validates completeness and orders by score. */
  readonly results: readonly RerankingResult[]
}

export interface RerankingModel extends RerankingModelRef {
  readonly costEstimator?: ModelCostEstimator
  resolve?(): Promise<RerankingModel>
  rerank(request: RerankingModelRequest): Promise<RerankingModelResult>
}

export function assertRerankingModel(model: RerankingModel): void {
  if (
    !model ||
    typeof model !== "object" ||
    typeof model.rerank !== "function" ||
    !validIdentifier(model.providerId) ||
    !validIdentifier(model.modelId) ||
    model.definition?.kind !== "reranking" ||
    model.definition.providerId !== model.providerId ||
    model.definition.modelId !== model.modelId
  ) {
    throw new TypeError("[Sixb] Expected a RerankingModel with a valid identity and rerank method.")
  }
}

export function validateRerankingResults(
  results: unknown,
  documentCount: number
): RerankingResult[] {
  if (!Array.isArray(results) || results.length !== documentCount) {
    throw new TypeError("[SixbModels] Reranking must return one result per document.")
  }
  const seen = new Set<number>()
  const validated = results.map((result: unknown) => {
    if (!result || typeof result !== "object") {
      throw new TypeError("[SixbModels] Invalid reranking result.")
    }
    const index: unknown = Reflect.get(result, "index")
    const score: unknown = Reflect.get(result, "score")
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= documentCount ||
      seen.has(index) ||
      typeof score !== "number" ||
      !Number.isFinite(score)
    ) {
      throw new TypeError("[SixbModels] Reranking requires unique valid indices and finite scores.")
    }
    seen.add(index)
    return { index, score }
  })
  // Stable ties preserve candidate rank, independent of the provider's response ordering.
  return validated.sort((left, right) => right.score - left.score || left.index - right.index)
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}

export class RerankingModelResponseError extends ModelProviderError {
  constructor(
    message: string,
    providerId: string,
    modelId: string,
    readonly metadata: RerankingModelResponseMetadata,
    options?: { cause?: unknown }
  ) {
    super(message, providerId, modelId, {
      code: "invalid_reranking_response",
      retryable: false,
      cause: options?.cause,
    })
  }
}
