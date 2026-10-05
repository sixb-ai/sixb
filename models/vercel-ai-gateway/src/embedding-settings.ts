import type { EmbeddingBatchLimits, EmbeddingModelRequest, JsonObject } from "@sixb/core/models"

interface GatewayEmbeddingSettings {
  readonly retrieval?: "voyage" | "cohere"
  readonly batching?: EmbeddingBatchLimits
}

/** Qualify model IDs explicitly; publisher prefixes do not guarantee compatible parameters. */
export function gatewayEmbeddingSettings(modelId: string): GatewayEmbeddingSettings {
  switch (modelId) {
    case "openai/text-embedding-3-small":
    case "openai/text-embedding-3-large":
    case "openai/text-embedding-ada-002":
      return {
        batching: { maxInputs: 2048, maxInputBytes: 8191, maxTotalInputBytes: 300000 },
      }
    case "voyage/voyage-4":
    case "voyage/voyage-4-lite":
    case "voyage/voyage-4-large":
      // Byte ceilings leave room for retrieval instructions within the 32K context.
      // https://docs.voyageai.com/reference/embeddings-api
      return {
        retrieval: "voyage",
        batching: { maxInputs: 1000, maxInputBytes: 31000, maxTotalInputBytes: 64000 },
      }
    case "cohere/embed-v4.0":
      // Bound aggregate bytes as well as the 96-text / 128K-context per-input limits.
      // https://docs.cohere.com/v2/reference/embed
      return {
        retrieval: "cohere",
        batching: { maxInputs: 96, maxInputBytes: 127000, maxTotalInputBytes: 127000 },
      }
    default:
      return {}
  }
}

/** Translate Sixb's retrieval role without exposing vendor parameters to vector profiles. */
export function gatewayEmbeddingProviderOptions(
  retrieval: GatewayEmbeddingSettings["retrieval"],
  purpose: EmbeddingModelRequest["purpose"],
  dimensions: number
): JsonObject | undefined {
  if (!retrieval) return undefined
  if (purpose !== "document" && purpose !== "query") {
    throw new TypeError(
      "[SixbVercelGateway] This embedding model requires purpose: 'document' or 'query'."
    )
  }

  switch (retrieval) {
    case "voyage":
      return {
        voyage: {
          inputType: purpose,
          truncation: false,
          // Gateway compatibility: /v1/embeddings returned 1024 for root dimensions: 512
          // on voyage-4-large (2026-10-05). Remove only after the root field works here.
          outputDimension: dimensions,
        },
      }
    case "cohere":
      return {
        cohere: {
          inputType: purpose === "query" ? "search_query" : "search_document",
          truncate: "NONE",
        },
      }
  }
}
