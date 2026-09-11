import { type ObjectReadExecutionLimits, ObjectReadLimitExceededError } from "../execution-limits"
import type {
  CompiledObjectReadRoot,
  CompiledObjectReadStep,
  CompiledSelectedObjectReadScope,
  ObjectLinkRow,
  ObjectRow,
} from "../types"
import { fullLinkRowKey, rowIdentityKey, rowIdentityKeyParts, sourceLinkBucketKey } from "./keys"
import type { InMemoryReadSource } from "./read-source"

export interface InMemoryReadUniverse extends InMemoryReadSource {
  readonly objects: ReadonlyMap<string, ObjectRow>
  readonly links: ReadonlyMap<string, ObjectLinkRow>
  readonly linksBySource: ReadonlyMap<string, readonly ObjectLinkRow[]>
  readonly objectProperties: ReadonlyMap<string, ReadonlySet<string>>
}

interface InMemoryReadPlan {
  readonly roots: readonly CompiledObjectReadRoot[]
  readonly selectionsByNode: ReadonlyMap<number, ReadonlyMap<string, ReadonlySet<string>>>
  readonly steps: readonly CompiledObjectReadStep[]
}

export function prepareReadPlan(scope: CompiledSelectedObjectReadScope): InMemoryReadPlan {
  const selectionsByNode = new Map<number, Map<string, ReadonlySet<string>>>()
  for (const selection of scope.objects) {
    const byType = selectionsByNode.get(selection.nodeId) ?? new Map()
    byType.set(selection.objectTypeId, new Set(selection.propertyIds))
    selectionsByNode.set(selection.nodeId, byType)
  }

  // The compiler allocates node ids parent-first. Resolve every step from lower parent ids to
  // higher child ids so a node reached through several concrete definitions is complete before
  // its nested selections run.
  const steps = [...scope.steps].sort(
    (left, right) =>
      left.parentNodeId - right.parentNodeId ||
      left.nodeId - right.nodeId ||
      left.sourceObjectTypeId.localeCompare(right.sourceObjectTypeId) ||
      left.linkId.localeCompare(right.linkId) ||
      left.targetObjectTypeId.localeCompare(right.targetObjectTypeId)
  )
  return {
    roots: scope.roots,
    selectionsByNode,
    steps,
  }
}

export function resolveSelectedReadUniverse(
  source: InMemoryReadSource,
  plan: InMemoryReadPlan,
  limits: ObjectReadExecutionLimits
): InMemoryReadUniverse {
  // Reachability stays path-sensitive until every finite selection step has run. The final
  // object/link universes union exact identities only after that traversal, so the same type
  // reached through another branch cannot inherit nested link authority.
  const reachableByNode = new Map<number, Map<string, ObjectRow>>()
  const rawObjects = new Map<string, ObjectRow>()
  const objectProperties = new Map<string, Set<string>>()
  const authorizedLinks = new Map<
    string,
    { readonly row: ObjectLinkRow; readonly propertyIds: Set<string> }
  >()
  let traversalFacts = 0
  const consumeTraversalFact = (): void => {
    traversalFacts += 1
    if (traversalFacts > limits.maxTraversalFacts) {
      throw new ObjectReadLimitExceededError("traversalFacts", limits.maxTraversalFacts)
    }
  }

  const addReachable = (nodeId: number, row: ObjectRow): void => {
    const selectedProperties = plan.selectionsByNode.get(nodeId)?.get(row.objectTypeId)
    if (!selectedProperties) return
    const key = rowIdentityKey(row)
    const reachable = reachableByNode.get(nodeId) ?? new Map<string, ObjectRow>()
    reachable.set(key, row)
    reachableByNode.set(nodeId, reachable)
    rawObjects.set(key, row)
    unionInto(objectProperties, key, selectedProperties)
  }

  for (const root of plan.roots) {
    const row = source.getObject(root.objectTypeId, root.primaryId)
    if (row) {
      consumeTraversalFact()
      addReachable(root.nodeId, row)
    }
  }

  for (const step of plan.steps) {
    const parents = reachableByNode.get(step.parentNodeId)
    if (!parents) continue
    for (const parent of parents.values()) {
      if (parent.objectTypeId !== step.sourceObjectTypeId) continue
      for (const link of source.outgoingLinks(parent.objectTypeId, parent.primaryId)) {
        if (link.linkId !== step.linkId || link.targetTypeId !== step.targetObjectTypeId) {
          continue
        }
        const target = source.getObject(link.targetTypeId, link.targetId)
        if (!target) continue
        consumeTraversalFact()
        addReachable(step.nodeId, target)

        const linkKey = fullLinkRowKey(link)
        const selected = authorizedLinks.get(linkKey)
        if (selected) {
          for (const propertyId of step.propertyIds) selected.propertyIds.add(propertyId)
        } else {
          authorizedLinks.set(linkKey, {
            row: link,
            propertyIds: new Set(step.propertyIds),
          })
        }
      }
    }
  }

  const objects = new Map<string, ObjectRow>()
  for (const [key, propertyIds] of objectProperties) {
    const row = rawObjects.get(key)
    if (row) objects.set(key, redactObjectRow(row, propertyIds))
  }

  const links = new Map<string, ObjectLinkRow>()
  for (const [key, selected] of authorizedLinks) {
    // Both endpoint identities must remain live and selected. This also prevents a stale link
    // from exposing metadata after its target object disappears.
    if (
      !objects.has(rowIdentityKeyParts(selected.row.sourceTypeId, selected.row.sourceId)) ||
      !objects.has(rowIdentityKeyParts(selected.row.targetTypeId, selected.row.targetId))
    ) {
      continue
    }
    links.set(key, redactLinkRow(selected.row, selected.propertyIds))
  }

  return createReadUniverse(source.projectId, objects, links, objectProperties)
}

function createReadUniverse(
  projectId: string,
  objects: ReadonlyMap<string, ObjectRow>,
  links: ReadonlyMap<string, ObjectLinkRow>,
  objectProperties: ReadonlyMap<string, ReadonlySet<string>>
): InMemoryReadUniverse {
  const linksBySource = new Map<string, ObjectLinkRow[]>()
  for (const link of links.values()) {
    const key = sourceLinkBucketKey(link.projectId, link.sourceTypeId, link.sourceId)
    const bucket = linksBySource.get(key) ?? []
    bucket.push(link)
    linksBySource.set(key, bucket)
  }
  return {
    projectId,
    objects,
    links,
    linksBySource,
    objectProperties,
    objectsOfType: (objectTypeId) =>
      [...objects.values()].filter((row) => row.objectTypeId === objectTypeId),
    getObject: (objectTypeId, primaryId) =>
      objects.get(rowIdentityKeyParts(objectTypeId, primaryId)),
    outgoingLinks: (objectTypeId, primaryId) =>
      linksBySource.get(sourceLinkBucketKey(projectId, objectTypeId, primaryId)) ?? [],
    allLinks: () => links.values(),
  }
}

function unionInto(
  target: Map<string, Set<string>>,
  key: string,
  values: ReadonlySet<string>
): void {
  const union = target.get(key) ?? new Set<string>()
  for (const value of values) union.add(value)
  target.set(key, union)
}

function redactObjectRow(row: ObjectRow, propertyIds: ReadonlySet<string>): ObjectRow {
  const clone = structuredClone(row)
  delete clone.links
  clone.properties = redactProperties(clone.properties, propertyIds)
  return clone
}

function redactLinkRow(row: ObjectLinkRow, propertyIds: ReadonlySet<string>): ObjectLinkRow {
  const clone = structuredClone(row)
  const properties = redactProperties(clone.properties ?? {}, propertyIds)
  if (Object.keys(properties).length === 0) {
    delete clone.properties
  } else {
    clone.properties = properties
  }
  return clone
}

function redactProperties(
  properties: Readonly<Record<string, unknown>>,
  propertyIds: ReadonlySet<string>
): Record<string, unknown> {
  // Object.fromEntries uses CreateDataProperty, so valid ontology ids such as `__proto__` remain
  // ordinary own properties without changing the returned object's prototype.
  return Object.fromEntries(
    [...propertyIds]
      .filter((propertyId) => Object.hasOwn(properties, propertyId))
      .map((propertyId) => [propertyId, properties[propertyId]])
  )
}
