import { sha256Canonical } from "../../materialization/identity"
import type { EmbeddingModelRef } from "../../models/embedding-model"

/** Bump when what a turn embeds changes: every conversation is then indexed again. */
const TURN_TEXT_FORMAT = 1

/**
 * The fingerprint every turn vector carries: the model that embedded it and how its text was made.
 * A vector of another fingerprint is stale, and indexing replaces it.
 */
export function agentTurnVectorConfiguration(model: EmbeddingModelRef): string {
  return sha256Canonical({
    index: "agent.turns",
    format: TURN_TEXT_FORMAT,
    provider: model.providerId,
    model: model.modelId,
    representation: model.definition.representation ?? { name: model.modelId },
    dimensions: model.definition.dimensions,
    ...(model.definition.inputMode === "asymmetric" ? { inputMode: "asymmetric" } : {}),
    metric: "cosine",
    precision: "float32",
    normalization: "l2-v1",
  })
}
