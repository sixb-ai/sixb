import {
  type ModelCostEstimator,
  type RerankingModel,
  type RerankingModelRequest,
  RerankingModelResponseError,
  type RerankingModelResponseMetadata,
  type RerankingResult,
} from "@sixb/core/models"

/** Gateway's versioned reranking protocol is shared by all its reranking providers. */
export function createGatewayReranking(
  modelId: string,
  request: (
    input: RerankingModelRequest
  ) => Promise<{ body: unknown; metadata: RerankingModelResponseMetadata }>,
  pricing?: { resolve?: () => Promise<ModelCostEstimator>; estimator?: ModelCostEstimator }
): RerankingModel {
  if (!modelId || modelId.trim() !== modelId) {
    throw new TypeError("[SixbVercelGateway] Reranking requires a nonempty trimmed model ID.")
  }
  const providerId = "vercel-ai-gateway"
  const resolvePricing = pricing?.resolve
  return Object.freeze({
    providerId,
    modelId,
    definition: Object.freeze({ kind: "reranking" as const, providerId, modelId }),
    costEstimator: pricing?.estimator,
    ...(resolvePricing
      ? {
          resolve: async () =>
            createGatewayReranking(modelId, request, { estimator: await resolvePricing() }),
        }
      : {}),
    async rerank(input: RerankingModelRequest) {
      input.signal?.throwIfAborted()
      if (
        typeof input.query !== "string" ||
        !input.query.trim() ||
        !Array.isArray(input.documents) ||
        input.documents.some((text) => typeof text !== "string" || !text.trim())
      ) {
        throw new TypeError(
          "[SixbVercelGateway] Reranking requires a query and nonempty document strings."
        )
      }
      const documents = [...input.documents]
      if (!documents.length) return { results: [] }
      const { body, metadata } = await request({ ...input, documents })
      const ranking: unknown =
        body && typeof body === "object" ? Reflect.get(body, "ranking") : undefined
      const invalid = () =>
        new RerankingModelResponseError(
          "[SixbVercelGateway] Invalid reranking response: expected one finite score per document with unique indices.",
          providerId,
          modelId,
          metadata
        )
      if (!Array.isArray(ranking) || ranking.length !== documents.length) throw invalid()

      const seen = new Set<number>()
      const results: RerankingResult[] = ranking.map((entry: unknown) => {
        if (!entry || typeof entry !== "object") throw invalid()
        const index: unknown = Reflect.get(entry, "index")
        const score: unknown = Reflect.get(entry, "relevanceScore")
        if (
          typeof index !== "number" ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= documents.length ||
          seen.has(index) ||
          typeof score !== "number" ||
          !Number.isFinite(score)
        )
          throw invalid()
        seen.add(index)
        return { index, score }
      })
      return { results, ...metadata }
    },
  })
}
