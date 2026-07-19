import type {
  MaterializationLinkScopeState,
  MaterializationSession,
  MaterializationStatePage,
  OntologyMaterializationStorage,
} from "../storage/ontology"
import { applyLinkEdit, applyObjectEdit } from "./apply-edits"
import {
  distinctCardinalityOneScopes,
  mergeWorkingState,
  provisionalLinkSnapshot,
  provisionalObjectSnapshot,
  resolveLink,
  resolveObject,
  resultingObjectSnapshot,
  validateWorkingCardinality,
  type WorkingLink,
  type WorkingObject,
  workingLinkFromState,
} from "./edit-working-state"
import { MaterializationValidationError } from "./errors"
import type { FixedCommitIdentity } from "./identity"
import { loadState, oneStateRequest, stateRequestForOperation } from "./load-state"
import type { MaterializerContext } from "./materializer-context"
import { linkRefKey, linkScopeKey, objectRefKey } from "./refs"
import type { OntologyEditOperation, OntologyObjectRef, OntologyOperationOutcome } from "./types"
import {
  validateEffectiveObject,
  validateLinkAuthorityProperties,
  validateLinkRef,
  validateObjectAuthorityProperties,
  validateObjectPatchPropertyIds,
  validateObjectRef,
} from "./validate-effective"

type ObjectOperation = Extract<OntologyEditOperation, { readonly kind: `object.${string}` }>
type LinkOperation = Extract<OntologyEditOperation, { readonly kind: `link.${string}` }>

export interface EditWorkingState {
  readonly objects: Map<string, WorkingObject>
  readonly links: Map<string, WorkingLink>
  readonly scopeSnapshots: Map<string, MaterializationLinkScopeState>
}

export async function applyEditOperation(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  operation: OntologyEditOperation,
  identity: FixedCommitIdentity
): Promise<OntologyOperationOutcome> {
  if (isObjectOperation(operation)) validateObjectRef(context.ontology, operation.ref)
  else validateLinkRef(context.ontology, operation.ref)

  const requested = stateRequestForOperation(operation)
  const requestedLink = requested.links[0]
  const linkDefinition = requestedLink
    ? context.ontology
        .resolveObjectType(requestedLink.source.objectTypeId)
        .links.find((candidate) => candidate.id === requestedLink.linkId)
    : null
  const request = {
    ...requested,
    objects: requested.objects.filter((ref) => !state.objects.has(objectRefKey(ref))),
    links: requested.links.filter((ref) => !state.links.has(linkRefKey(ref))),
    linkScopes: requested.linkScopes.filter(
      (scope) =>
        linkDefinition?.cardinality === "one" &&
        !state.scopeSnapshots.has(linkScopeKey(scope.source, scope.linkId))
    ),
  }
  const loaded = await loadState(context, storage, session, request)
  mergeWorkingState(state.objects, state.links, state.scopeSnapshots, loaded)

  return isObjectOperation(operation)
    ? applyObjectOperation(context, storage, session, state, operation, identity)
    : applyLinkOperation(context, state, operation, identity, linkDefinition?.cardinality)
}

async function applyObjectOperation(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  operation: ObjectOperation,
  identity: FixedCommitIdentity
): Promise<OntologyOperationOutcome> {
  const working = state.objects.get(objectRefKey(operation.ref))
  if (!working) throw new MaterializationValidationError("Object state was not loaded.")
  const normalizedProperties =
    operation.kind === "object.create" || operation.kind === "object.upsert"
      ? validateObjectAuthorityProperties(context.ontology, operation.ref, operation.properties)
      : undefined
  const normalizedSet =
    operation.kind === "object.patch"
      ? validateObjectAuthorityProperties(context.ontology, operation.ref, operation.set)
      : undefined
  if (operation.kind === "object.patch") {
    validateObjectPatchPropertyIds(context.ontology, operation.ref, operation.unset, "unset")
    validateObjectPatchPropertyIds(context.ontology, operation.ref, operation.reset, "reset")
  }

  const currentEffective = resolveObject(context.ontology, working)
  const transition = applyObjectEdit({
    operation,
    sourceProperties: working.source?.assertion.properties ?? null,
    authority: working.override,
    effective: currentEffective
      ? provisionalObjectSnapshot(working, currentEffective, identity)
      : null,
    ...(normalizedProperties !== undefined ? { normalizedProperties } : {}),
    ...(normalizedSet !== undefined ? { normalizedSet } : {}),
  })
  const previous = working.override
  working.override = transition.next
  try {
    const resolved = resolveObject(context.ontology, working)
    if (Boolean(currentEffective) !== Boolean(resolved)) {
      await loadIncidentLinks(context, storage, session, state, operation.ref)
    }
    if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)
    validateWorkingCardinality(context.ontology, state.objects, state.links, state.scopeSnapshots)
  } catch (error) {
    working.override = previous
    throw error
  }
  const stepObject = resolveObject(context.ontology, working)
  return {
    id: operation.id,
    ok: true,
    authority: transition.changed ? "changed" : "unchanged",
    ...(stepObject ? { object: resultingObjectSnapshot(working, stepObject, identity) } : {}),
  }
}

function applyLinkOperation(
  context: MaterializerContext,
  state: EditWorkingState,
  operation: LinkOperation,
  identity: FixedCommitIdentity,
  cardinality: "one" | "many" | undefined
): OntologyOperationOutcome {
  const working = state.links.get(linkRefKey(operation.ref))
  if (!working) throw new MaterializationValidationError("Link state was not loaded.")
  const sourceEndpoint = state.objects.get(objectRefKey(operation.ref.source))
  const targetEndpoint = state.objects.get(objectRefKey(operation.ref.target))
  if (
    operation.kind === "link.upsert" &&
    (!sourceEndpoint ||
      !targetEndpoint ||
      !resolveObject(context.ontology, sourceEndpoint) ||
      !resolveObject(context.ontology, targetEndpoint))
  ) {
    throw new MaterializationValidationError("Link upsert requires both endpoints to be effective.")
  }
  const normalizedProperties =
    operation.kind === "link.upsert"
      ? validateLinkAuthorityProperties(context.ontology, operation.ref, operation.properties)
      : undefined
  const currentEffective = resolveLink(context.ontology, working, state.objects)
  const transition = applyLinkEdit({
    operation,
    hasSource: working.source !== null,
    authority: working.override,
    effective: currentEffective
      ? provisionalLinkSnapshot(working, currentEffective, identity)
      : null,
    ...(normalizedProperties !== undefined ? { normalizedProperties } : {}),
  })
  const previous = working.override
  working.override = transition.next
  try {
    if (cardinality === "one") {
      validateWorkingCardinality(context.ontology, state.objects, state.links, state.scopeSnapshots)
    }
  } catch (error) {
    working.override = previous
    throw error
  }
  return {
    id: operation.id,
    ok: true,
    authority: transition.changed ? "changed" : "unchanged",
  }
}

async function loadIncidentLinks(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  ref: OntologyObjectRef
): Promise<void> {
  for await (const incidentPage of storage.streamState({
    session,
    requests: oneStateRequest({
      objects: [],
      links: [],
      linkScopes: [],
      incidentObjects: [ref],
      points: [],
    }),
    pageRows: context.batching.statePageRows,
  })) {
    await mergeIncidentLinks(context, storage, session, state, incidentPage)
    const missingScopes = distinctCardinalityOneScopes(
      context.ontology,
      incidentPage.links.filter((link) => state.links.has(linkRefKey(link.ref))),
      state.scopeSnapshots
    )
    if (missingScopes.length > 0) {
      const scopeState = await loadState(context, storage, session, {
        objects: [],
        links: [],
        linkScopes: missingScopes,
        incidentObjects: [],
        points: [],
      })
      mergeWorkingState(state.objects, state.links, state.scopeSnapshots, scopeState)
    }
  }
}

async function mergeIncidentLinks(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  page: MaterializationStatePage
): Promise<void> {
  const missingEndpoints = new Map<string, OntologyObjectRef>()
  for (const link of page.links) {
    for (const ref of [link.ref.source, link.ref.target]) {
      if (!state.objects.has(objectRefKey(ref))) missingEndpoints.set(objectRefKey(ref), ref)
    }
  }
  if (missingEndpoints.size > 0) {
    const endpointState = await loadState(context, storage, session, {
      objects: [...missingEndpoints.values()],
      links: [],
      linkScopes: [],
      incidentObjects: [],
      points: [],
    })
    mergeWorkingState(state.objects, new Map(), new Map(), endpointState)
  }
  for (const link of page.links) {
    const key = linkRefKey(link.ref)
    if (state.links.has(key)) continue
    const working = workingLinkFromState(link)
    if (link.effective || resolveLink(context.ontology, working, state.objects)) {
      state.links.set(key, working)
    }
  }
  context.observeCoreBuffer?.("edits.incident-links", state.links.size)
}

function isObjectOperation(operation: OntologyEditOperation): operation is ObjectOperation {
  switch (operation.kind) {
    case "object.create":
    case "object.upsert":
    case "object.patch":
    case "object.delete":
    case "object.restore":
      return true
    case "link.upsert":
    case "link.delete":
    case "link.reset":
      return false
  }
}
