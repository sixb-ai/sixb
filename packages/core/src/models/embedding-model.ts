import type { ModelDefinition } from "./definitions"
import { ModelProviderError } from "./errors"
import type { ModelProviderIds, ModelRoute, ModelUsage } from "./events"
import type { ModelCostEstimator, ModelReportedCost } from "./pricing"

/** The identity includes the configured output dimension, not only the vendor's model id. */
export interface EmbeddingModelDefinition extends ModelDefinition {
  readonly kind: "embedding"
  readonly dimensions: number
  /** Actual representation behind a routing alias. Omit only when modelId identifies it directly. */
  readonly representation?: { readonly name: string; readonly version?: string }
}

export interface EmbeddingModelRequest {
  readonly texts: readonly string[]
  /** Providers must honor cancellation and propagate this signal to their transport. */
  readonly signal?: AbortSignal
}

/** Provider accounting facts; absent meters or prices remain unknown. */
export interface EmbeddingModelResponseMetadata {
  readonly usage?: ModelUsage
  readonly providerIds?: ModelProviderIds
  readonly responseModelId?: string
  readonly reportedCost?: ModelReportedCost
  readonly route?: ModelRoute
}

export interface EmbeddingModelResult extends EmbeddingModelResponseMetadata {
  readonly vectors: readonly (readonly number[])[]
}

/** Provider contract. Calling it is explicit; declaring a profile never invokes a model. */
export interface EmbeddingModelRef {
  readonly providerId: string
  readonly modelId: string
  readonly definition: EmbeddingModelDefinition
}

export interface EmbeddingModel extends EmbeddingModelRef {
  readonly costEstimator?: ModelCostEstimator
  /** Resolve and pin optional pricing before admission, without an inference call. */
  resolve?(): Promise<EmbeddingModel>
  embed(request: EmbeddingModelRequest): Promise<EmbeddingModelResult>
}

export function assertEmbeddingModel(model: EmbeddingModel): void {
  if (!model || typeof model !== "object" || typeof model.embed !== "function") {
    throw new TypeError("[Sixb] Expected an EmbeddingModel with an embed method.")
  }
  assertEmbeddingModelRef(model)
}

export function assertEmbeddingModelRef(model: EmbeddingModelRef): void {
  const definition = model?.definition
  const representation = definition?.representation
  if (
    representation !== undefined &&
    (!representation ||
      typeof representation !== "object" ||
      !validIdentityPart(representation.name) ||
      (representation.version !== undefined && !validIdentityPart(representation.version)))
  )
    throw new TypeError("[Sixb] Invalid embedding model representation.")
  if (
    !definition ||
    definition.kind !== "embedding" ||
    definition.providerId !== model.providerId ||
    definition.modelId !== model.modelId ||
    typeof model.providerId !== "string" ||
    !model.providerId ||
    model.providerId.trim() !== model.providerId ||
    typeof model.modelId !== "string" ||
    !model.modelId ||
    model.modelId.trim() !== model.modelId ||
    !Number.isSafeInteger(definition.dimensions) ||
    definition.dimensions < 1 ||
    definition.dimensions > 16000
  ) {
    throw new TypeError("[Sixb] Invalid embedding model identity or dimensions (expected 1–16000).")
  }
}

/** Routing identity, representation and dimensions must agree before any inference. */
export function sameEmbeddingModel(left: EmbeddingModelRef, right: EmbeddingModelRef): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.definition.dimensions === right.definition.dimensions &&
    (left.definition.representation?.name ?? left.modelId) ===
      (right.definition.representation?.name ?? right.modelId) &&
    left.definition.representation?.version === right.definition.representation?.version
  )
}

function validIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}

/** A completed provider response whose vectors are unusable, but may still be billable. */
export class EmbeddingModelResponseError extends ModelProviderError {
  constructor(
    message: string,
    providerId: string,
    modelId: string,
    readonly metadata: EmbeddingModelResponseMetadata
  ) {
    super(message, providerId, modelId, { code: "invalid_embedding_response", retryable: false })
  }
}
