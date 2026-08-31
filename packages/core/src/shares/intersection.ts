import { type RuntimeAccessPlan, snapshotRuntimeAccessPlan } from "../authorization"
import type { ObjectRef } from "../ontology"
import type {
  ObjectReadLinkDefinitionSelection,
  ObjectReadLinkSelection,
  ObjectReadNode,
  ObjectReadObjectSelection,
  ObjectReadRoot,
} from "../storage/objects/types"

/**
 * Narrow an issued snapshot by the Share definition registered now.
 *
 * Intersection is recursive and id-based. Anything added to the definition or ontology after
 * issuance is absent from `issued` and therefore cannot appear in the effective plan.
 */
export function intersectShareAccessPlans(
  issued: RuntimeAccessPlan,
  current: RuntimeAccessPlan
): RuntimeAccessPlan {
  const issuedSnapshot = snapshotRuntimeAccessPlan(issued)
  const currentSnapshot = snapshotRuntimeAccessPlan(current)
  const grants: RuntimeAccessPlan["grants"][number][] = []

  const issuedRoots = viewRoots(issuedSnapshot)
  const currentRoots = viewRoots(currentSnapshot)
  const roots: ObjectReadRoot[] = []
  for (const issuedRoot of issuedRoots) {
    for (const currentRoot of currentRoots) {
      if (!refsEqual(issuedRoot.anchor, currentRoot.anchor)) continue
      const node = intersectNodes(issuedRoot.node, currentRoot.node)
      if (node.objects.length === 0) continue
      roots.push({ anchor: { ...issuedRoot.anchor }, node })
    }
  }
  if (roots.length > 0) {
    grants.push({ kind: "object.view", selection: { kind: "selected", roots } })
  }

  for (const issuedGrant of issuedSnapshot.grants) {
    if (issuedGrant.kind !== "action.apply") continue
    const subjects = issuedGrant.subjects.filter((subject) =>
      currentSnapshot.grants.some(
        (currentGrant) =>
          currentGrant.kind === "action.apply" &&
          currentGrant.actionId === issuedGrant.actionId &&
          currentGrant.subjects.some((currentSubject) => refsEqual(subject, currentSubject))
      )
    )
    if (subjects.length > 0) {
      grants.push({
        kind: "action.apply",
        actionId: issuedGrant.actionId,
        subjects: subjects.map((subject) => ({ ...subject })),
      })
    }
  }

  return snapshotRuntimeAccessPlan({ grants })
}

function viewRoots(plan: RuntimeAccessPlan): readonly ObjectReadRoot[] {
  return plan.grants.flatMap((grant) =>
    grant.kind === "object.view" ? [...grant.selection.roots] : []
  )
}

function intersectNodes(issued: ObjectReadNode, current: ObjectReadNode): ObjectReadNode {
  const objects: ObjectReadObjectSelection[] = []
  for (const issuedObject of issued.objects) {
    const currentObject = current.objects.find(
      (candidate) => candidate.objectTypeId === issuedObject.objectTypeId
    )
    if (!currentObject) continue
    objects.push({
      objectTypeId: issuedObject.objectTypeId,
      propertyIds: intersectStrings(issuedObject.propertyIds, currentObject.propertyIds),
    })
  }
  const allowedSourceIds = new Set(objects.map((object) => object.objectTypeId))
  const links: ObjectReadLinkSelection[] = []
  for (const issuedLink of issued.links) {
    for (const currentLink of current.links) {
      const link = intersectLinkSelections(issuedLink, currentLink, allowedSourceIds)
      if (link) links.push(link)
    }
  }
  return {
    objects: objects.sort((a, b) => a.objectTypeId.localeCompare(b.objectTypeId)),
    links,
  }
}

function intersectLinkSelections(
  issued: ObjectReadLinkSelection,
  current: ObjectReadLinkSelection,
  allowedSourceIds: ReadonlySet<string>
): ObjectReadLinkSelection | null {
  const definitions: ObjectReadLinkDefinitionSelection[] = []
  const allowedTargetIds = new Set<string>()
  for (const issuedDefinition of issued.definitions) {
    if (!allowedSourceIds.has(issuedDefinition.sourceObjectTypeId)) continue
    for (const currentDefinition of current.definitions) {
      if (
        currentDefinition.sourceObjectTypeId !== issuedDefinition.sourceObjectTypeId ||
        currentDefinition.linkId !== issuedDefinition.linkId
      ) {
        continue
      }
      const targetObjectTypeIds = intersectStrings(
        issuedDefinition.targetObjectTypeIds,
        currentDefinition.targetObjectTypeIds
      )
      if (targetObjectTypeIds.length === 0) continue
      for (const id of targetObjectTypeIds) allowedTargetIds.add(id)
      definitions.push({
        sourceObjectTypeId: issuedDefinition.sourceObjectTypeId,
        linkId: issuedDefinition.linkId,
        targetObjectTypeIds,
        propertyIds: intersectStrings(issuedDefinition.propertyIds, currentDefinition.propertyIds),
      })
    }
  }
  if (definitions.length === 0) return null

  const intersectedTarget = intersectNodes(issued.target, current.target)
  const target = restrictNodeToTypes(intersectedTarget, allowedTargetIds)
  if (target.objects.length === 0) return null
  const visibleTargetIds = new Set(target.objects.map((object) => object.objectTypeId))
  const visibleDefinitions = definitions
    .map((definition) => ({
      ...definition,
      targetObjectTypeIds: definition.targetObjectTypeIds.filter((id) => visibleTargetIds.has(id)),
    }))
    .filter((definition) => definition.targetObjectTypeIds.length > 0)
  if (visibleDefinitions.length === 0) return null
  return { definitions: visibleDefinitions, target }
}

function restrictNodeToTypes(
  node: ObjectReadNode,
  allowedIds: ReadonlySet<string>
): ObjectReadNode {
  const objects = node.objects.filter((object) => allowedIds.has(object.objectTypeId))
  const sourceIds = new Set(objects.map((object) => object.objectTypeId))
  const links: ObjectReadLinkSelection[] = []
  for (const link of node.links) {
    const definitions = link.definitions.filter((definition) =>
      sourceIds.has(definition.sourceObjectTypeId)
    )
    if (definitions.length === 0) continue
    const targetIds = new Set(definitions.flatMap((definition) => definition.targetObjectTypeIds))
    const target = restrictNodeToTypes(link.target, targetIds)
    if (target.objects.length === 0) continue
    const visibleTargetIds = new Set(target.objects.map((object) => object.objectTypeId))
    const visibleDefinitions = definitions
      .map((definition) => ({
        ...definition,
        targetObjectTypeIds: definition.targetObjectTypeIds.filter((id) =>
          visibleTargetIds.has(id)
        ),
      }))
      .filter((definition) => definition.targetObjectTypeIds.length > 0)
    if (visibleDefinitions.length > 0) links.push({ definitions: visibleDefinitions, target })
  }
  return { objects, links }
}

function intersectStrings(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right)
  return [...new Set(left.filter((value) => rightSet.has(value)))].sort((a, b) =>
    a.localeCompare(b)
  )
}

function refsEqual(left: ObjectRef, right: ObjectRef): boolean {
  return left.objectTypeId === right.objectTypeId && left.primaryId === right.primaryId
}
