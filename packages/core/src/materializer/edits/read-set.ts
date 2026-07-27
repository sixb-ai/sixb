import type {
  OntologyEditOperation,
  OntologyLinkRef,
  OntologyObjectRef,
} from "../../materialization/model"
import {
  compareLinkRefs,
  compareObjectRefs,
  linkRefKey,
  linkScopeKey,
  objectRefKey,
} from "../../materialization/refs"
import type { OntologyRegistry } from "../../ontology"
import type { MaterializationStateRequestChunk } from "../../storage/ontology"

/** Builds the complete state read set required by an ordered edit commit. */
export function buildEditReadSet(
  ontology: OntologyRegistry,
  operations: readonly OntologyEditOperation[]
): MaterializationStateRequestChunk {
  const objects = new Map<string, OntologyObjectRef>()
  const links = new Map<string, OntologyLinkRef>()
  const scopes = new Map<string, { readonly source: OntologyObjectRef; readonly linkId: string }>()
  const incidentObjects = new Map<string, OntologyObjectRef>()

  for (const operation of operations) {
    if (isObjectOperation(operation)) {
      if (!ontology.getObjectTypeById(operation.ref.objectTypeId)) continue
      objects.set(objectRefKey(operation.ref), operation.ref)
      if (operation.kind !== "object.patch") {
        incidentObjects.set(objectRefKey(operation.ref), operation.ref)
      }
      continue
    }

    if (!isKnownLinkRef(ontology, operation.ref)) continue
    links.set(linkRefKey(operation.ref), operation.ref)
    objects.set(objectRefKey(operation.ref.source), operation.ref.source)
    objects.set(objectRefKey(operation.ref.target), operation.ref.target)
    if (linkCardinality(ontology, operation.ref) === "one") {
      const scope = { source: operation.ref.source, linkId: operation.ref.linkId }
      scopes.set(linkScopeKey(scope.source, scope.linkId), scope)
    }
  }

  return {
    objects: [...objects.values()].sort(compareObjectRefs),
    links: [...links.values()].sort(compareLinkRefs),
    linkScopes: [...scopes.values()].sort((left, right) =>
      linkScopeKey(left.source, left.linkId).localeCompare(linkScopeKey(right.source, right.linkId))
    ),
    incidentObjects: [...incidentObjects.values()].sort(compareObjectRefs),
    points: [],
  }
}

export function isKnownLinkRef(ontology: OntologyRegistry, ref: OntologyLinkRef): boolean {
  const sourceType = ontology.getObjectTypeById(ref.source.objectTypeId)
  if (!sourceType || !ontology.getObjectTypeById(ref.target.objectTypeId)) return false
  const link = sourceType.links.find((candidate) => candidate.id === ref.linkId)
  return Boolean(
    link && ontology.isValidLinkTarget(link.targetObjectTypeId, ref.target.objectTypeId)
  )
}

export function linkCardinality(ontology: OntologyRegistry, ref: OntologyLinkRef): "one" | "many" {
  // Validation still belongs to the individual operation so `continue` mode can report an
  // invalid reference without aborting the whole preload. Unknown references need no scope read.
  const definition = ontology
    .getObjectTypeById(ref.source.objectTypeId)
    ?.links.find((candidate) => candidate.id === ref.linkId)
  return definition?.cardinality ?? "many"
}

function isObjectOperation(
  operation: OntologyEditOperation
): operation is Extract<OntologyEditOperation, { readonly kind: `object.${string}` }> {
  return operation.kind.startsWith("object.")
}
