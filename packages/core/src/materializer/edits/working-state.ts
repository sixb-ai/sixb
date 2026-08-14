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
import { linkCardinality } from "./read-set"
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
  readonly source: MaterializationLinkScopeState["sourceAssertion"]
  readonly originalOverride: StoredLinkSlotOverride | null
  override: LinkSlotOverride | null
  readonly before: MaterializationLinkScopeState["effective"]
  readonly effectiveCount: number
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
    if (
      linkCardinality(ontology, link.ref) !== "one" &&
      !working.links.edges.has(linkRefKey(link.ref))
    ) {
      working.links.edges.set(linkRefKey(link.ref), workingLinkEdgeFromState(link))
    }
  }
  for (const scope of state.linkScopes) {
    const key = linkScopeKey(scope.source, scope.linkId)
    if (!working.links.slots.has(key)) {
      working.links.slots.set(key, workingLinkSlotFromState(scope))
    }
  }
}

function workingLinkSlotFromState(scope: MaterializationLinkScopeState): WorkingLinkSlot {
  return {
    ref: { source: scope.source, linkId: scope.linkId },
    source: scope.sourceAssertion,
    originalOverride: scope.override,
    override: usableLinkSlotOverride(scope.override),
    before: scope.effective,
    effectiveCount: scope.effectiveCount,
  }
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
  existing: ReadonlyMap<string, WorkingLinkSlot>
): { readonly source: OntologyObjectRef; readonly linkId: string }[] {
  const scopes = new Map<string, { readonly source: OntologyObjectRef; readonly linkId: string }>()
  for (const state of links) {
    const key = linkScopeKey(state.ref.source, state.ref.linkId)
    if (linkCardinality(ontology, state.ref) === "one" && !existing.has(key)) {
      scopes.set(key, { source: state.ref.source, linkId: state.ref.linkId })
    }
  }
  return [...scopes.values()]
}

export function validateWorkingCardinality(slots: ReadonlyMap<string, WorkingLinkSlot>): void {
  for (const { effectiveCount, ref } of slots.values()) {
    if (effectiveCount <= 1) continue
    throw new MaterializationValidationError(
      `Link scope '${ref.source.objectTypeId}.${ref.linkId}' has cardinality one.`
    )
  }
}
