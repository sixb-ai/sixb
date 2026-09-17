import type { ModelDefinition } from "./definitions"

/** The identity includes the configured output dimension, not only the vendor's model id. */
export interface EmbeddingModelDefinition extends ModelDefinition {
  readonly kind: "embedding"
  readonly dimensions: number
}

export interface EmbeddingModelRequest {
  readonly texts: readonly string[]
  readonly signal?: AbortSignal
}

export interface EmbeddingModelResult {
  readonly vectors: readonly (readonly number[])[]
}

/** Provider contract. Calling it is explicit; declaring a profile never invokes a model. */
export interface EmbeddingModelRef {
  readonly providerId: string
  readonly modelId: string
  readonly definition: EmbeddingModelDefinition
}

export interface EmbeddingModel extends EmbeddingModelRef {
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
