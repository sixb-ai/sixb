import { MaterializationValidationError } from "../../materialization/errors"
import type {
  LinkOverride,
  LinkSlotOverride,
  ObjectOverride,
  OntologyLinkRef,
  OntologyLinkScopeRef,
  OntologyObjectRef,
} from "../../materialization/model"
import { linkRefKey, linkScopeKey, objectRefKey } from "../../materialization/refs"
import type { OntologyRegistry } from "../../ontology"
import type {
  MaterializationLinkScopeState,
  MaterializationLinkState,
  MaterializationObjectState,
  MaterializationStatePage,
  StoredLinkOverride,
  StoredLinkSlotOverride,
  StoredObjectOverride,
  StoredTelemetryPoint,
} from "../../storage/ontology"
import {
  type ResolvedLinkValue,
  type ResolvedObjectValue,
  resolveEffectiveLink,
  resolveEffectiveLinkSlot,
  resolveEffectiveObject,
  usableLinkSlotOverride,
} from "../effective/resolve"
import { isKnownLinkRef } from "./read-set"
export interface WorkingObject {
  ref: OntologyObjectRef
  source: MaterializationObjectState["source"]
  originalOverride: StoredObjectOverride | null
  override: ObjectOverride | null
  before: MaterializationObjectState["effective"]
  latestTelemetry: StoredTelemetryPoint[]
}

export interface WorkingLinkEdge {
  ref: OntologyLinkRef
  source: MaterializationLinkState["source"]
  originalOverride: StoredLinkOverride | null
  override: LinkOverride | null
  before: MaterializationLinkState["effective"]
}

export interface WorkingLinkSlot {
  readonly ref: OntologyLinkScopeRef
  source: MaterializationLinkScopeState["sourceAssertion"]
  readonly originalOverride: StoredLinkSlotOverride | null
  override: LinkSlotOverride | null
  before: MaterializationLinkScopeState["effective"]
}

/**
 * Transaction-local edit working set.
 *
 * Loaded snapshots remain pinned to the commit start while each successful operation updates the
 * mutable override. Operation N+1 can therefore observe operation N before anything is durable.
 */
export interface EditWorkingState {
  readonly objects: Map<string, WorkingObject>
  /**
   * Link authorities use two identity grains:
   * - edges are keyed by `(source, linkId, target)` for cardinality-many links;
   * - slots are keyed by `(source, linkId)` and select at most one target for
   *   cardinality-one links.
   */
  readonly links: {
    readonly edges: Map<string, WorkingLinkEdge>
    readonly slots: Map<string, WorkingLinkSlot>
    readonly scopeSnapshots: Map<string, MaterializationLinkScopeState>
  }
}

export function mergeWorkingState(
  ontology: OntologyRegistry,
  working: EditWorkingState,
  state: MaterializationStatePage
): void {
  for (const object of state.objects) {
    if (!working.objects.has(objectRefKey(object.ref))) {
      working.objects.set(objectRefKey(object.ref), workingObjectFromState(object))
    }
  }
  for (const link of state.links) {
    if (linkCardinality(ontology, link.ref) === "one") {
      mergeLinkSlotState(working.links.slots, linkSlotFromLinkState(link))
    } else if (!working.links.edges.has(linkRefKey(link.ref))) {
      working.links.edges.set(linkRefKey(link.ref), workingLinkEdgeFromState(link))
    }
  }
  for (const scope of state.linkScopes) {
    const key = linkScopeKey(scope.source, scope.linkId)
    if (!working.links.scopeSnapshots.has(key)) {
      working.links.scopeSnapshots.set(key, scope)
      mergeLinkSlotState(working.links.slots, linkSlotFromScopeState(scope))
    }
  }
}

function linkSlotFromLinkState(link: MaterializationLinkState): WorkingLinkSlot {
  return {
    ref: { source: link.ref.source, linkId: link.ref.linkId },
    source: link.source,
    originalOverride: link.slotOverride,
    override: usableLinkSlotOverride(link.slotOverride),
    before: link.effective,
  }
}

function linkSlotFromScopeState(scope: MaterializationLinkScopeState): WorkingLinkSlot {
  return {
    ref: { source: scope.source, linkId: scope.linkId },
    source: scope.sourceAssertion,
    originalOverride: scope.override,
    override: usableLinkSlotOverride(scope.override),
    before: scope.effective,
  }
}

function mergeLinkSlotState(slots: Map<string, WorkingLinkSlot>, incoming: WorkingLinkSlot): void {
  const key = linkScopeKey(incoming.ref.source, incoming.ref.linkId)
  const existing = slots.get(key)
  if (!existing) {
    slots.set(key, incoming)
    return
  }
  existing.source ??= incoming.source
  existing.before ??= incoming.before
}

export function workingObjectFromState(object: MaterializationObjectState): WorkingObject {
  return {
    ref: object.ref,
    source: object.source,
    originalOverride: object.override,
    override: object.override?.value ?? null,
    before: object.effective,
    latestTelemetry: [...object.latestTelemetry],
  }
}

export function workingLinkEdgeFromState(link: MaterializationLinkState): WorkingLinkEdge {
  return {
    ref: link.ref,
    source: link.source,
    originalOverride: link.override,
    override: link.override?.value ?? null,
    before: link.effective,
  }
}

export function resolveObject(
  ontology: OntologyRegistry,
  working: WorkingObject
): ResolvedObjectValue | null {
  return resolveEffectiveObject({
    ref: working.ref,
    primaryPropertyId: ontology.getPrimaryPropertyId(working.ref.objectTypeId),
    source: working.source,
    override: working.override,
    latestTelemetry: working.latestTelemetry,
  })
}

export function resolveLinkEdge(
  ontology: OntologyRegistry,
  working: WorkingLinkEdge,
  objects: Map<string, WorkingObject>
): ResolvedLinkValue | null {
  const source = objects.get(objectRefKey(working.ref.source))
  const target = objects.get(objectRefKey(working.ref.target))
  return resolveEffectiveLink({
    ref: working.ref,
    source: working.source,
    override: working.override,
    sourceEndpointExists: Boolean(source && resolveObject(ontology, source)),
    targetEndpointExists: Boolean(target && resolveObject(ontology, target)),
  })
}

export function resolveLinkSlot(
  ontology: OntologyRegistry,
  working: WorkingLinkSlot,
  objects: Map<string, WorkingObject>
): ResolvedLinkValue | null {
  return resolveEffectiveLinkSlot({
    scope: working.ref,
    source: working.source,
    override: working.override,
    endpointExists: (ref) => {
      const object = objects.get(objectRefKey(ref))
      return Boolean(object && resolveObject(ontology, object))
    },
  })
}

export function distinctCardinalityOneScopes(
  ontology: OntologyRegistry,
  links: readonly MaterializationLinkState[],
  existing: Map<string, MaterializationLinkScopeState>
): { readonly source: OntologyObjectRef; readonly linkId: string }[] {
  const scopes = new Map<string, { readonly source: OntologyObjectRef; readonly linkId: string }>()
  for (const state of links) {
    const definition = ontology
      .resolveObjectType(state.ref.source.objectTypeId)
      .links.find((candidate) => candidate.id === state.ref.linkId)
    const key = linkScopeKey(state.ref.source, state.ref.linkId)
    if (definition?.cardinality === "one" && !existing.has(key)) {
      scopes.set(key, { source: state.ref.source, linkId: state.ref.linkId })
    }
  }
  return [...scopes.values()]
}

export function validateWorkingCardinality(
  ontology: OntologyRegistry,
  scopes: Map<string, MaterializationLinkScopeState>
): void {
  for (const { effectiveCount, source, linkId } of scopes.values()) {
    if (effectiveCount <= 1) continue
    const link = ontology
      .resolveObjectType(source.objectTypeId)
      .links.find((candidate) => candidate.id === linkId)
    if (link?.cardinality === "one") {
      throw new MaterializationValidationError(
        `Link scope '${source.objectTypeId}.${linkId}' has cardinality one.`
      )
    }
  }
}

function linkCardinality(
  ontology: OntologyRegistry,
  ref: OntologyLinkRef
): "one" | "many" | undefined {
  if (!isKnownLinkRef(ontology, ref)) return undefined
  return ontology
    .resolveObjectType(ref.source.objectTypeId)
    .links.find((candidate) => candidate.id === ref.linkId)?.cardinality
}
