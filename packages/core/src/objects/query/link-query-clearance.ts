import type { OntologyRegistry } from "../../ontology"
import { type PropertyClearance, unreadableError } from "../property-clearance"
import type { ObjectQuery } from "./ir"
import { type ExecuteObjectQueryLinksInput, preflightObjectQueryLinks } from "./links"

/**
 * Refuse a link query that could return a link, or an endpoint, the reader cannot read.
 *
 * A link query returns every link incident to the objects it selects, a page at a time. The page
 * cannot be filtered afterward without breaking its cursor, so what the reader cannot read is
 * refused before the page is read, from the definitions: a link that is unreadable, or that leads
 * to an unreadable object type, whether or not such a link exists.
 */
export function assertLinkQueryReadable(input: {
  readonly ontology: OntologyRegistry
  readonly clearance: PropertyClearance
  readonly query: ObjectQuery
  readonly request: Omit<ExecuteObjectQueryLinksInput, "query">
  /** Whether grants alone let the reader view the type: storage already leaves out the others. */
  readonly viewableByGrants: (objectTypeId: string) => boolean
}): void {
  const { ontology, clearance } = input
  const { types, links } = clearance.unreadable()
  if (types.size === 0 && links.length === 0) return

  const preflight = preflightObjectQueryLinks(
    { ...input.request, query: input.query },
    { ontology }
  )

  const selected = preflight.validated.result.objectTypeIds
  const outgoing = preflight.direction !== "incoming"
  const incoming = preflight.direction !== "outgoing"

  const named = (linkId: string) => preflight.linkId === undefined || preflight.linkId === linkId
  const targets = (expected: string | readonly string[], objectTypeId: string) =>
    (typeof expected === "string" ? [expected] : expected).some((target) =>
      ontology.isValidLinkTarget(target, objectTypeId)
    )

  for (const link of links) {
    if (!named(link.linkId)) continue
    if (
      (outgoing && selected.includes(link.objectTypeId)) ||
      (incoming && selected.some((id) => targets(link.targetObjectTypeId, id)))
    ) {
      throw unreadableError(link)
    }
  }

  const sealed = [...types].filter(([id]) => input.viewableByGrants(id))
  if (sealed.length === 0) return

  for (const objectType of ontology.listObjectTypes()) {
    for (const link of objectType.links) {
      if (!named(link.id)) continue
      if (outgoing && selected.includes(objectType.id)) {
        const other = sealed.find(([id]) => targets(link.targetObjectTypeId, id))
        if (other) throw unreadableError(other[1])
      }

      const source = types.get(objectType.id)
      if (
        incoming &&
        source &&
        input.viewableByGrants(objectType.id) &&
        selected.some((id) => targets(link.targetObjectTypeId, id))
      ) {
        throw unreadableError(source)
      }
    }
  }
}
