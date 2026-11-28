import type { ObjectExpansion } from "./ir"

/** The object types a provider should look at for a traversal or expansion: every type if undefined. */
export function linkEndpointObjectTypeIds(
  link: Pick<ObjectExpansion, "direction" | "sourceObjectTypeId" | "endpointObjectTypeIds">
): readonly string[] | undefined {
  if (link.endpointObjectTypeIds?.length) return link.endpointObjectTypeIds

  return link.direction === "incoming" && link.sourceObjectTypeId !== undefined
    ? [link.sourceObjectTypeId]
    : undefined
}
