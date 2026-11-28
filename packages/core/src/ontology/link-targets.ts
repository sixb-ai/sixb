/** What this module needs of the ontology, shared by type shapes and object queries. */
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
