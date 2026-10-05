import type { ObjectQuery, ObjectQueryRerank } from "./ir"

/** Validation permits output shaping only after the explicit reranking stage. */
export function findQueryReranking(query: ObjectQuery): ObjectQueryRerank | undefined {
  if (query.kind === "rerank") return query
  if (query.kind === "limit" || query.kind === "project") return findQueryReranking(query.input)
  return undefined
}
