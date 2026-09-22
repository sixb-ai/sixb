import {
  type EmbeddingModel,
  type EmbeddingModelRequest,
  EmbeddingModelResponseError,
  type EmbeddingModelResponseMetadata,
  type ModelCostEstimator,
} from "@sixb/core/models"

export interface VercelGatewayEmbeddingOptions {
  /** Requested output dimension; part of the model identity used by vector profiles. */
  readonly dimensions: number
}

/** Internal adapter: transport/authentication stay owned by the configured gateway. */
export function createGatewayEmbedding(
  modelId: string,
  options: VercelGatewayEmbeddingOptions,
  request: (
    input: EmbeddingModelRequest,
    dimensions: number
  ) => Promise<{ body: unknown; metadata: EmbeddingModelResponseMetadata }>,
  pricing?: { resolve?: () => Promise<ModelCostEstimator>; estimator?: ModelCostEstimator }
): EmbeddingModel {
  const dimensions = options.dimensions
  if (
    !modelId ||
    modelId.trim() !== modelId ||
    !Number.isSafeInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 16000
  ) {
    throw new TypeError(
      "[SixbVercelGateway] Embedding model requires a nonempty model id and dimensions between 1 and 16000."
    )
  }
  const providerId = "vercel-ai-gateway"
  const resolvePricing = pricing?.resolve
  return Object.freeze({
    providerId,
    modelId,
    costEstimator: pricing?.estimator,
    // Only advertise bounds for known OpenAI models; other gateway routes stay individual.
    ...(/^openai\/text-embedding-(3-small|3-large|ada-002)$/.test(modelId)
      ? {
          batching: Object.freeze({
            maxInputs: 2048,
            maxInputBytes: 8191,
            maxTotalInputBytes: 300000,
          }),
        }
      : {}),
    ...(resolvePricing
      ? {
          resolve: async () =>
            createGatewayEmbedding(modelId, { dimensions }, request, {
              estimator: await resolvePricing(),
            }),
        }
      : {}),
    definition: Object.freeze({
      kind: "embedding" as const,
      providerId,
      modelId,
      dimensions,
      representation: Object.freeze({ name: modelId }),
    }),
    async embed(input: EmbeddingModelRequest) {
      input.signal?.throwIfAborted()
      if (
        !Array.isArray(input.texts) ||
        input.texts.some((text) => typeof text !== "string" || !text.trim())
      ) {
        throw new TypeError("[SixbVercelGateway] Embedding inputs must be nonempty strings.")
      }
      const texts = [...input.texts]
      if (!texts.length) return { vectors: [] }
      const { body: result, metadata } = await request({ ...input, texts }, dimensions)
      if (!isRecord(result) || !Array.isArray(result.data) || result.data.length !== texts.length) {
        throw invalidResponse(modelId, metadata)
      }
      const vectors: number[][] = new Array(texts.length)
      for (const entry of result.data) {
        if (
          !isRecord(entry) ||
          !Number.isSafeInteger(entry.index) ||
          typeof entry.index !== "number" ||
          entry.index < 0 ||
          entry.index >= texts.length ||
          vectors[entry.index] !== undefined ||
          !Array.isArray(entry.embedding) ||
          entry.embedding.length !== dimensions
        )
          throw invalidResponse(modelId, metadata)
        const values: number[] = []
        for (const value of entry.embedding) {
          if (typeof value !== "number" || !Number.isFinite(Math.fround(value)))
            throw invalidResponse(modelId, metadata)
          values.push(value)
        }
        if (!values.some((value) => Math.fround(value) !== 0))
          throw invalidResponse(modelId, metadata)
        vectors[entry.index] = values
      }
      return { vectors, ...metadata }
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidResponse(
  modelId: string,
  metadata: EmbeddingModelResponseMetadata
): EmbeddingModelResponseError {
  return new EmbeddingModelResponseError(
    "[SixbVercelGateway] Invalid embedding response: expected one finite, nonzero vector of the configured dimension per input, with unique indices.",
    "vercel-ai-gateway",
    modelId,
    metadata
  )
}
