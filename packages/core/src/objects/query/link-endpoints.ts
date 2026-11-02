import type { ObjectExpansion } from "./ir"

/** What this module needs of the ontology, shared by query validation and query preparation. */
interface LinkTargetCatalog {
  listSubTypes(objectTypeId: string): string[]
}

/** Every type a link declaration allows, subtypes included. Undefined for a wildcard link. */
export function linkTargetObjectTypeIds(
  targetObjectTypeId: string | readonly string[],
  ontology: LinkTargetCatalog
): readonly string[] | undefined {
  const declared =
    typeof targetObjectTypeId === "string" ? [targetObjectTypeId] : targetObjectTypeId
  if (declared.includes("*")) return undefined

  return [...new Set(declared.flatMap((id) => [id, ...ontology.listSubTypes(id)]))].sort()
}

/** The object types a provider should look at for a traversal or expansion: every type if undefined. */
export function linkEndpointObjectTypeIds(
  link: Pick<ObjectExpansion, "direction" | "sourceObjectTypeId" | "endpointObjectTypeIds">
): readonly string[] | undefined {
  if (link.endpointObjectTypeIds?.length) return link.endpointObjectTypeIds

  return link.direction === "incoming" && link.sourceObjectTypeId !== undefined
    ? [link.sourceObjectTypeId]
    : undefined
}
