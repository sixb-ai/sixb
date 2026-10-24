import type { ObjectQueryPredicate } from "../../../objects/query"
import { matchesPredicate } from "../../../objects/query/matches-predicate"
import type {
  CompiledConditionalObjectReadScope,
  ObjectLinkRow,
  ObjectQueryCapabilities,
  ObjectReadStorage,
  ObjectRow,
} from "../types"
import type { InMemoryReadSource, InMemoryScopedReadSource } from "./read-source"
import { createInMemoryScopedReader } from "./scoped-reader"

/** Read the live store through a conditional scope. */
export function createInMemoryConditionalReader(
  source: InMemoryReadSource,
  scope: CompiledConditionalObjectReadScope,
  queryCapabilities: () => ObjectQueryCapabilities
): ObjectReadStorage {
  const conditional = createConditionalReadSource(source, scope)

  return createInMemoryScopedReader({
    projectId: source.projectId,
    resolve: () => conditional,
    queryCapabilities,
  })
}

/**
 * Filter the live source as it is read: an object of a conditioned type exists only while its
 * condition matches, and a link only while both its endpoints do.
 */
function createConditionalReadSource(
  source: InMemoryReadSource,
  scope: CompiledConditionalObjectReadScope
): InMemoryScopedReadSource {
  const predicates = new Map<string, ObjectQueryPredicate>(
    scope.conditions.map((condition) => [condition.objectTypeId, condition.predicate])
  )

  const isVisible = (row: ObjectRow): boolean => {
    const predicate = predicates.get(row.objectTypeId)
    return predicate === undefined || matchesPredicate(row, predicate)
  }

  const getObject = (objectTypeId: string, primaryId: string): ObjectRow | undefined => {
    const row = source.getObject(objectTypeId, primaryId)
    return row && isVisible(row) ? row : undefined
  }

  // An endpoint of an unconditioned type is read as unscoped storage reads it, stored or not.
  const isVisibleEndpoint = (objectTypeId: string, primaryId: string): boolean =>
    !predicates.has(objectTypeId) || getObject(objectTypeId, primaryId) !== undefined

  const isVisibleLink = (link: ObjectLinkRow): boolean =>
    isVisibleEndpoint(link.sourceTypeId, link.sourceId) &&
    isVisibleEndpoint(link.targetTypeId, link.targetId)

  return {
    projectId: source.projectId,
    selectsProperty: (objectTypeId, primaryId) => getObject(objectTypeId, primaryId) !== undefined,
    // Read only for rows a query already found here.
    getVector: (ref, profile) => source.getVector?.(ref, profile),
    allObjects: () => [...source.allObjects()].filter(isVisible),
    objectsOfType: (objectTypeId) => source.objectsOfType(objectTypeId).filter(isVisible),
    getObject,
    outgoingLinks: (objectTypeId, primaryId) =>
      [...source.outgoingLinks(objectTypeId, primaryId)].filter(isVisibleLink),
    allLinks: () => [...source.allLinks()].filter(isVisibleLink),
    // A hidden holder is read through getObject, which finds nothing.
    uniqueHolder: (value) => source.uniqueHolder(value),
  }
}
