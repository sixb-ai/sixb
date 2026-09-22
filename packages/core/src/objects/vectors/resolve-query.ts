import type { EmbeddingModelCatalog } from "../../models/catalog"
import { type EmbeddingModel, sameEmbeddingModel } from "../../models/embedding-model"
import type { OntologyRegistry } from "../../ontology"
import { ObjectQueryExecutionError } from "../query/errors"
import type { ObjectQuery, ObjectQueryVector } from "../query/ir"
import { normalizeVector } from "./profile"

const QUERY_EMBEDDING_TIMEOUT_MS = 30_000

/** Called only after query validation, authorization and provider planning have succeeded. */
export async function resolveVectorSearchText(
  query: ObjectQuery,
  ontology: OntologyRegistry,
  models: EmbeddingModelCatalog | undefined,
  signal?: AbortSignal
): Promise<ObjectQuery> {
  if (query.kind === "limit" || query.kind === "project") {
    const input = await resolveVectorSearchText(query.input, ontology, models, signal)
    return { ...query, input }
  }
  if (query.kind !== "vector" || typeof query.vector !== "string") return query

  const model = resolveProfileEmbeddingModel(query, ontology, models)
  const vector = await embedSearchText(query.vector, model, signal)
  return { ...query, vector }
}

function resolveProfileEmbeddingModel(
  query: ObjectQueryVector,
  ontology: OntologyRegistry,
  models: EmbeddingModelCatalog | undefined
): EmbeddingModel {
  let input = query.input
  while (input.kind === "filter") input = input.input
  if (input.kind !== "start" || !query.profile) {
    throw new ObjectQueryExecutionError(
      "embedding_model_unavailable",
      "Vector search requires the embedding model registered for its profile."
    )
  }

  const profile = ontology.resolveObjectType(input.objectTypeId).search?.vectors?.[query.profile]
  if (!profile) {
    throw new ObjectQueryExecutionError(
      "embedding_model_unavailable",
      "Vector search requires the embedding model registered for its profile."
    )
  }

  const model = models?.getByRef({
    provider: profile.model.providerId,
    modelId: profile.model.modelId,
  })?.model
  if (!model || !sameEmbeddingModel(model, profile.model)) {
    throw new ObjectQueryExecutionError(
      "embedding_model_unavailable",
      "Vector search requires the embedding model registered for its profile."
    )
  }
  return model
}

async function embedSearchText(
  text: string,
  model: EmbeddingModel,
  signal?: AbortSignal
): Promise<readonly number[]> {
  const dimensions = model.definition.dimensions
  const timeout = AbortSignal.timeout(QUERY_EMBEDDING_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  requestSignal.throwIfAborted()
  const result = await model.embed({ texts: [text], signal: requestSignal })
  requestSignal.throwIfAborted()

  if (!Array.isArray(result?.vectors) || result.vectors.length !== 1) {
    throw new ObjectQueryExecutionError(
      "invalid_embedding_response",
      "Embedding model must return exactly one vector for the search text."
    )
  }
  try {
    return normalizeVector(result.vectors[0]!, dimensions)
  } catch {
    throw new ObjectQueryExecutionError(
      "invalid_embedding_response",
      "Embedding model returned an invalid vector for the search profile."
    )
  }
}
