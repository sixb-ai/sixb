import { MaterializationValidationError } from "../../materialization/errors"
import type {
  OntologyEditOperation,
  OntologyObjectRef,
  OntologyOperationOutcome,
} from "../../materialization/model"
import { linkRefKey, linkScopeKey, objectRefKey } from "../../materialization/refs"
import type {
  MaterializationLinkScopeState,
  MaterializationSession,
  MaterializationStatePage,
  OntologyMaterializationStorage,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { loadState, oneStateRequest, stateRequestForOperation } from "../effective/load-state"
import {
  validateEffectiveObject,
  validateLinkAuthorityProperties,
  validateLinkRef,
  validateObjectAuthorityProperties,
  validateObjectPatchPropertyIds,
  validateObjectRef,
} from "../effective/validate"
import type { TimedCommitIdentity } from "../shared/identity"
import { applyLinkEdit, applyObjectEdit } from "./apply"
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
} from "./working-state"

type ObjectOperation = Extract<OntologyEditOperation, { readonly kind: `object.${string}` }>
type LinkOperation = Extract<OntologyEditOperation, { readonly kind: `link.${string}` }>

/**
 * Transaction-local edit working set.
 *
 * Loaded snapshots remain pinned to the commit start while each successful operation updates the
 * mutable override. Operation N+1 can therefore observe operation N before anything is durable.
 */
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
  identity: TimedCommitIdentity
): Promise<OntologyOperationOutcome> {
  validateOperationRef(context, operation)
  const cardinality = await loadOperationState(context, storage, session, state, operation)
  if (isObjectOperation(operation)) {
    return applyObjectOperation(context, storage, session, state, operation, identity)
  }
  return applyLinkOperation(context, state, operation, identity, cardinality)
}

function validateOperationRef(
  context: Pick<MaterializerContext, "ontology">,
  operation: OntologyEditOperation
): void {
  if (isObjectOperation(operation)) {
    validateObjectRef(context.ontology, operation.ref)
    return
  }
  validateLinkRef(context.ontology, operation.ref)
}

async function loadOperationState(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  operation: OntologyEditOperation
): Promise<"one" | "many" | undefined> {
  const requested = stateRequestForOperation(operation)
  const requestedLink = requested.links[0]
  const cardinality = requestedLinkCardinality(context, requestedLink)
  const request = {
    ...requested,
    objects: requested.objects.filter((ref) => !state.objects.has(objectRefKey(ref))),
    links: requested.links.filter((ref) => !state.links.has(linkRefKey(ref))),
    linkScopes: requested.linkScopes.filter(
      (scope) =>
        cardinality === "one" && !state.scopeSnapshots.has(linkScopeKey(scope.source, scope.linkId))
    ),
  }
  const loaded = await loadState(context, storage, session, request)
  mergeWorkingState(state.objects, state.links, state.scopeSnapshots, loaded)
  return cardinality
}

function requestedLinkCardinality(
  context: Pick<MaterializerContext, "ontology">,
  requestedLink: ReturnType<typeof stateRequestForOperation>["links"][number] | undefined
): "one" | "many" | undefined {
  if (!requestedLink) return undefined
  return context.ontology
    .resolveObjectType(requestedLink.source.objectTypeId)
    .links.find((candidate) => candidate.id === requestedLink.linkId)?.cardinality
}

async function applyObjectOperation(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  operation: ObjectOperation,
  identity: TimedCommitIdentity
): Promise<OntologyOperationOutcome> {
  const working = requireWorkingObject(state, operation)
  const normalized = validateObjectOperation(context, operation)
  const currentEffective = resolveObject(context.ontology, working)
  const effectiveSnapshot = provisionalObjectOrNull(working, currentEffective, identity)
  const transition = applyObjectEdit({
    operation,
    sourceProperties: working.source?.assertion.properties ?? null,
    authority: working.override,
    effective: effectiveSnapshot,
    ...normalized,
  })

  await applyObjectTransition(
    context,
    storage,
    session,
    state,
    working,
    transition.next,
    currentEffective !== null,
    operation
  )

  return objectOperationOutcome(operation, working, transition.changed, context, identity)
}

function provisionalObjectOrNull(
  working: WorkingObject,
  resolved: ReturnType<typeof resolveObject>,
  identity: TimedCommitIdentity
) {
  if (!resolved) return null
  return provisionalObjectSnapshot(working, resolved, identity)
}

function requireWorkingObject(state: EditWorkingState, operation: ObjectOperation): WorkingObject {
  const working = state.objects.get(objectRefKey(operation.ref))
  if (!working) throw new MaterializationValidationError("Object state was not loaded.")
  return working
}

function validateObjectOperation(
  context: Pick<MaterializerContext, "ontology">,
  operation: ObjectOperation
): {
  readonly normalizedProperties?: ReturnType<typeof validateObjectAuthorityProperties>
  readonly normalizedSet?: ReturnType<typeof validateObjectAuthorityProperties>
} {
  switch (operation.kind) {
    case "object.create":
    case "object.upsert":
      return {
        normalizedProperties: validateObjectAuthorityProperties(
          context.ontology,
          operation.ref,
          operation.properties
        ),
      }
    case "object.patch":
      validateObjectPatchPropertyIds(context.ontology, operation.ref, operation.unset, "unset")
      validateObjectPatchPropertyIds(context.ontology, operation.ref, operation.reset, "reset")
      return {
        normalizedSet: validateObjectAuthorityProperties(
          context.ontology,
          operation.ref,
          operation.set
        ),
      }
    case "object.delete":
    case "object.restore":
      return {}
  }
}

async function applyObjectTransition(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  working: WorkingObject,
  next: WorkingObject["override"],
  existedBefore: boolean,
  operation: ObjectOperation
): Promise<void> {
  const previous = working.override
  working.override = next
  try {
    const resolved = resolveObject(context.ontology, working)
    if (existedBefore !== Boolean(resolved)) {
      await loadIncidentLinks(context, storage, session, state, operation.ref)
    }
    if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)
    validateWorkingCardinality(context.ontology, state.objects, state.links, state.scopeSnapshots)
  } catch (error) {
    working.override = previous
    throw error
  }
}

function objectOperationOutcome(
  operation: ObjectOperation,
  working: WorkingObject,
  changed: boolean,
  context: Pick<MaterializerContext, "ontology">,
  identity: TimedCommitIdentity
): OntologyOperationOutcome {
  const outcome: OntologyOperationOutcome = {
    id: operation.id,
    ok: true,
    authority: authorityOutcome(changed),
  }
  const resolved = resolveObject(context.ontology, working)
  if (!resolved) return outcome
  return { ...outcome, object: resultingObjectSnapshot(working, resolved, identity) }
}

function applyLinkOperation(
  context: MaterializerContext,
  state: EditWorkingState,
  operation: LinkOperation,
  identity: TimedCommitIdentity,
  cardinality: "one" | "many" | undefined
): OntologyOperationOutcome {
  const working = requireWorkingLink(state, operation)
  validateLinkEndpoints(context, state, operation)
  const normalizedProperties = validateLinkOperation(context, operation)
  const currentEffective = resolveLink(context.ontology, working, state.objects)
  const effectiveSnapshot = provisionalLinkOrNull(working, currentEffective, identity)
  const transitionInput = {
    operation,
    hasSource: working.source !== null,
    authority: working.override,
    effective: effectiveSnapshot,
  }
  const transition = applyValidatedLinkEdit(transitionInput, normalizedProperties)
  applyLinkTransition(context, state, working, transition.next, cardinality)
  return { id: operation.id, ok: true, authority: authorityOutcome(transition.changed) }
}

function provisionalLinkOrNull(
  working: WorkingLink,
  resolved: ReturnType<typeof resolveLink>,
  identity: TimedCommitIdentity
) {
  if (!resolved) return null
  return provisionalLinkSnapshot(working, resolved, identity)
}

function applyValidatedLinkEdit(
  input: Parameters<typeof applyLinkEdit>[0],
  normalizedProperties: ReturnType<typeof validateLinkAuthorityProperties> | undefined
) {
  if (normalizedProperties === undefined) return applyLinkEdit(input)
  return applyLinkEdit({ ...input, normalizedProperties })
}

function requireWorkingLink(state: EditWorkingState, operation: LinkOperation): WorkingLink {
  const working = state.links.get(linkRefKey(operation.ref))
  if (!working) throw new MaterializationValidationError("Link state was not loaded.")
  return working
}

function validateLinkEndpoints(
  context: Pick<MaterializerContext, "ontology">,
  state: EditWorkingState,
  operation: LinkOperation
): void {
  if (operation.kind !== "link.upsert") return
  const source = state.objects.get(objectRefKey(operation.ref.source))
  const target = state.objects.get(objectRefKey(operation.ref.target))
  const sourceExists = source && resolveObject(context.ontology, source)
  const targetExists = target && resolveObject(context.ontology, target)
  if (sourceExists && targetExists) return
  throw new MaterializationValidationError("Link upsert requires both endpoints to be effective.")
}

function validateLinkOperation(
  context: Pick<MaterializerContext, "ontology">,
  operation: LinkOperation
): ReturnType<typeof validateLinkAuthorityProperties> | undefined {
  if (operation.kind !== "link.upsert") return undefined
  return validateLinkAuthorityProperties(context.ontology, operation.ref, operation.properties)
}

function applyLinkTransition(
  context: Pick<MaterializerContext, "ontology">,
  state: EditWorkingState,
  working: WorkingLink,
  next: WorkingLink["override"],
  cardinality: "one" | "many" | undefined
): void {
  const previous = working.override
  working.override = next
  try {
    if (cardinality === "one") {
      validateWorkingCardinality(context.ontology, state.objects, state.links, state.scopeSnapshots)
    }
  } catch (error) {
    working.override = previous
    throw error
  }
}

function authorityOutcome(changed: boolean): "changed" | "unchanged" {
  if (changed) return "changed"
  return "unchanged"
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
