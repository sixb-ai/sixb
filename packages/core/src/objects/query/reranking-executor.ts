import type { RerankingModel } from "../../models/reranking-model"
import { validateRerankingResults } from "../../models/reranking-model"
import type { ObjectRow, QueryObjectsResult } from "../../storage"
import { vectorSources } from "../vectors/profile"
import { ObjectQueryExecutionError } from "./errors"
import type { ObjectQuery, ObjectQueryVector } from "./ir"
import { MAX_RERANK_INPUT_BYTES } from "./reranking-limits"

/** Receives only rows from the authorized reader; never rereads unmasked storage. */
export async function rerankObjectCandidates(input: {
  readonly query: ObjectQuery
  readonly vector: ObjectQueryVector
  readonly candidates: readonly ObjectRow[]
  readonly model: RerankingModel
  readonly signal?: AbortSignal
  readonly includeTotal?: boolean
}): Promise<QueryObjectsResult> {
  const { vector, candidates, model, signal } = input
  if (typeof vector.vector !== "string" || !vector.source) {
    throw new ObjectQueryExecutionError(
      "invalid_rerank_input",
      "Reranking requires a validated text vector query."
    )
  }
  signal?.throwIfAborted()
  if (candidates.length > vector.k) {
    throw new ObjectQueryExecutionError(
      "rerank_candidate_limit_exceeded",
      "Storage exceeded the admitted vector candidate bound."
    )
  }
  const source = vector.source
  const documents = candidates.map((row) => vectorSources(source, row.properties).text)
  const encoder = new TextEncoder()
  const bytes =
    encoder.encode(vector.vector).byteLength +
    documents.reduce((sum, text) => sum + encoder.encode(text).byteLength, 0)
  if (bytes > MAX_RERANK_INPUT_BYTES) {
    throw new ObjectQueryExecutionError(
      "rerank_input_limit_exceeded",
      "Reranking input exceeds 1 MiB. Use fewer candidates or shorter profile sources."
    )
  }

  const results =
    documents.length === 0
      ? []
      : (await model.rerank({ query: vector.vector, documents, signal })).results
  signal?.throwIfAborted()
  const ranking = validateRerankingResults(results, candidates.length)
  const rows = ranking.map(({ index, score }) => ({ ...candidates[index]!, score }))
  const shaped = shapeRerankedRows(input.query, rows)
  return {
    objects: shaped.rows,
    hasMore: shaped.hasMore,
    ...(input.includeTotal === false ? {} : { total: shaped.total }),
  }
}

function shapeRerankedRows(
  query: ObjectQuery,
  rows: readonly ObjectRow[]
): { rows: readonly ObjectRow[]; total: number; hasMore: boolean } {
  if (query.kind === "rerank") return { rows, total: rows.length, hasMore: false }
  if (query.kind === "limit") {
    const input = shapeRerankedRows(query.input, rows)
    return {
      rows: input.rows.slice(0, query.limit),
      total: input.total,
      hasMore: input.hasMore || query.limit < input.rows.length,
    }
  }
  if (query.kind === "project") {
    const input = shapeRerankedRows(query.input, rows)
    if (!query.properties) return input
    const properties = new Set(query.properties)
    return {
      ...input,
      rows: input.rows.map((row) => ({
        ...row,
        properties: Object.fromEntries(
          Object.entries(row.properties).filter(([key]) => properties.has(key))
        ),
      })),
    }
  }
  throw new ObjectQueryExecutionError(
    "invalid_rerank_composition",
    "Only limit and project may follow reranking."
  )
}
