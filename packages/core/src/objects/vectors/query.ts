import type { ObjectQuery } from "../query/ir"

export function hasVectorProfile(query: ObjectQuery): boolean {
  if (query.kind === "vector") return true
  if (query.kind === "set") return query.inputs.some(hasVectorProfile)
  return "input" in query && hasVectorProfile(query.input)
}

/** V1 supports one exact top-k, with filters applied before ranking. */
export function isVectorProfileQuery(query: ObjectQuery): boolean {
  if (query.kind === "limit" || query.kind === "project") return isVectorProfileQuery(query.input)
  if (query.kind !== "vector" || !query.profile) return false
  let input = query.input
  while (input.kind === "filter") input = input.input
  return input.kind === "start" && !input.includeSubtypes
}
