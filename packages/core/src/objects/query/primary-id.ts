import type { OntologyDefinitionCatalog } from "../../ontology/registry"
import type { ObjectQuery, ObjectQueryPredicate } from "./ir"

/** Exact identity predicates can start from primary-key lookups. Keep the original filter:
 * the optimization must not remove other conditions or expose a projected-out property.
 * Only a direct start is rewritten; filters after bounds/projections keep their semantics. */
export function usePrimaryIdLookups(
  query: ObjectQuery,
  ontology: OntologyDefinitionCatalog
): ObjectQuery {
  if (query.kind === "set")
    return { ...query, inputs: query.inputs.map((input) => usePrimaryIdLookups(input, ontology)) }
  if (!("input" in query)) return query
  const input = usePrimaryIdLookups(query.input, ontology)
  if (query.kind === "filter" && input.kind === "start" && !input.includeSubtypes) {
    const propertyId = ontology.getPrimaryPropertyId(input.objectTypeId)
    const ids = primaryIds(query.predicate, propertyId)
    if (ids?.length && ids.length <= 1000)
      return {
        ...query,
        input: {
          kind: "refs",
          refs: [...new Set(ids)]
            .sort()
            .map((primaryId) => ({ objectTypeId: input.objectTypeId, primaryId })),
        },
      }
  }
  return input === query.input ? query : { ...query, input }
}

function primaryIds(
  predicate: ObjectQueryPredicate,
  propertyId: string
): readonly string[] | undefined {
  if (predicate.op === "and") {
    for (const item of predicate.items) {
      const ids = primaryIds(item, propertyId)
      if (ids) return ids
    }
    return undefined
  }
  if (
    predicate.op === "eq" &&
    predicate.propertyId === propertyId &&
    typeof predicate.value === "string"
  )
    return [predicate.value]
  if (
    predicate.op === "in" &&
    predicate.propertyId === propertyId &&
    predicate.values.every((value) => typeof value === "string")
  )
    return predicate.values as readonly string[]
  return undefined
}
