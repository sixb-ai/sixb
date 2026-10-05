import type { ObjectQuery } from "../query/ir"

export function hasVectorProfile(query: ObjectQuery): boolean {
  if (query.kind === "vector") return true
  if (query.kind === "set") return query.inputs.some(hasVectorProfile)
  return "input" in query && hasVectorProfile(query.input)
}

/** Rank one eligible object set; validation resolves its type and admits every traversed edge. */
export function isVectorProfileQuery(query: ObjectQuery): boolean {
  if (query.kind === "limit" || query.kind === "project") return isVectorProfileQuery(query.input)
  if (query.kind === "rerank") {
    return query.input.kind === "vector" && isVectorProfileQuery(query.input)
  }
  if (query.kind !== "vector" || !query.profile) return false
  return isVectorCandidateQuery(query.input)
}

function isVectorCandidateQuery(query: ObjectQuery): boolean {
  switch (query.kind) {
    case "start":
      return !query.includeSubtypes
    case "refs":
      return true
    case "filter":
    case "traverse":
      return isVectorCandidateQuery(query.input)
    case "set":
      return query.inputs.every(isVectorCandidateQuery)
    default:
      return false
  }
}
