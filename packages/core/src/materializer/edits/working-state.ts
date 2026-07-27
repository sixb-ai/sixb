import { MaterializationValidationError } from "../../materialization/errors"
import type {
  LinkOverride,
  ObjectOverride,
  OntologyLinkRef,
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
  StoredObjectOverride,
  StoredTelemetryPoint,
} from "../../storage/ontology"
import {
  type ResolvedLinkValue,
  type ResolvedObjectValue,
  resolveEffectiveLink,
  resolveEffectiveObject,
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

export interface WorkingLink {
  ref: OntologyLinkRef
  source: MaterializationLinkState["source"]
  originalOverride: StoredLinkOverride | null
  override: LinkOverride | null
  before: MaterializationLinkState["effective"]
}

export function mergeWorkingState(
  objects: Map<string, WorkingObject>,
  links: Map<string, WorkingLink>,
  scopes: Map<string, MaterializationLinkScopeState>,
  state: MaterializationStatePage
): void {
  for (const object of state.objects) {
    if (!objects.has(objectRefKey(object.ref))) {
      objects.set(objectRefKey(object.ref), workingObjectFromState(object))
    }
  }
  for (const link of state.links) {
    if (!links.has(linkRefKey(link.ref))) {
      links.set(linkRefKey(link.ref), workingLinkFromState(link))
    }
  }
  for (const scope of state.linkScopes) {
    if (!scopes.has(linkScopeKey(scope.source, scope.linkId))) {
      scopes.set(linkScopeKey(scope.source, scope.linkId), scope)
    }
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

export function workingLinkFromState(link: MaterializationLinkState): WorkingLink {
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

export function resolveLink(
  ontology: OntologyRegistry,
  working: WorkingLink,
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
  objects: Map<string, WorkingObject>,
  links: Map<string, WorkingLink>,
  scopes: Map<string, MaterializationLinkScopeState>
): void {
  const effectiveByScope = new Map<
    string,
    { count: number; source: OntologyObjectRef; linkId: string }
  >()
  for (const [scope, snapshot] of scopes) {
    effectiveByScope.set(scope, {
      count: snapshot.effectiveCount,
      source: snapshot.source,
      linkId: snapshot.linkId,
    })
  }
  for (const working of links.values()) {
    if (!isKnownLinkRef(ontology, working.ref)) continue
    const scope = linkScopeKey(working.ref.source, working.ref.linkId)
    const state = effectiveByScope.get(scope)
    if (!state) continue
    const before = working.before ? 1 : 0
    const after = resolveLink(ontology, working, objects) ? 1 : 0
    state.count += after - before
  }
  for (const { count, source, linkId } of effectiveByScope.values()) {
    if (count <= 1) continue
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
