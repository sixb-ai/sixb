import type { OntologyObjectRef } from "../../materialization/model"
import { linkRefKey, linkScopeKey, objectRefKey } from "../../materialization/refs"
import type {
  MaterializationLinkState,
  MaterializationSession,
  MaterializationStateRequestChunk,
  OntologyMaterializationStorage,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { loadState, oneStateRequest } from "../effective/load-state"
import { resolveEffectiveLinkSlotMember, usableLinkSlotOverride } from "../effective/resolve"
import { buildEditReadSet, isKnownLinkRef, linkCardinality } from "./read-set"
import {
  distinctCardinalityOneScopes,
  type EditWorkingState,
  mergeWorkingState,
  resolveLinkEdge,
  resolveObject,
  workingLinkEdgeFromState,
} from "./working-state"

export async function loadEditWorkingState(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  operations: Parameters<typeof buildEditReadSet>[1]
): Promise<EditWorkingState> {
  const state: EditWorkingState = {
    objects: new Map(),
    links: {
      edges: new Map(),
      slots: new Map(),
      scopeSnapshots: new Map(),
    },
  }
  const readSet = buildEditReadSet(context.ontology, operations)
  const explicitLinkKeys = new Set(readSet.links.map(linkRefKey))
  const explicitLinkSlots = new Set(
    readSet.linkScopes.map((scope) => linkScopeKey(scope.source, scope.linkId))
  )
  const incidentLinks = new Map<string, MaterializationLinkState>()
  const loadedState: EditWorkingState = {
    objects: state.objects,
    links: {
      edges: new Map(),
      slots: state.links.slots,
      scopeSnapshots: state.links.scopeSnapshots,
    },
  }
  const revivingObjects = new Set(
    operations.filter(isRevivingObjectOperation).map((operation) => objectRefKey(operation.ref))
  )

  for await (const page of storage.streamState({
    session,
    requests: oneStateRequest(readSet),
    pageRows: context.batching.statePageRows,
  })) {
    mergeWorkingState(context.ontology, loadedState, page)
    for (const link of page.links) {
      const key = linkRefKey(link.ref)
      if (
        linkCardinality(context.ontology, link.ref) !== "one" &&
        explicitLinkKeys.has(key) &&
        !state.links.edges.has(key)
      ) {
        state.links.edges.set(key, workingLinkEdgeFromState(link))
      }
      if (readSet.incidentObjects.length > 0) incidentLinks.set(key, link)
    }
  }

  for (const key of state.links.slots.keys()) {
    if (!explicitLinkSlots.has(key)) state.links.slots.delete(key)
  }

  await mergeMissingLinkSlotEndpoints(context, storage, session, state)

  await mergeIncidentState(
    context,
    storage,
    session,
    state,
    [...incidentLinks.values()],
    revivingObjects
  )
  return state
}

function isRevivingObjectOperation(
  operation: Parameters<typeof buildEditReadSet>[1][number]
): operation is Extract<
  Parameters<typeof buildEditReadSet>[1][number],
  { readonly kind: "object.create" | "object.upsert" | "object.restore" }
> {
  return (
    operation.kind === "object.create" ||
    operation.kind === "object.upsert" ||
    operation.kind === "object.restore"
  )
}

async function mergeIncidentState(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  incidentStates: readonly MaterializationLinkState[],
  revivingObjects: ReadonlySet<string>
): Promise<void> {
  const knownIncidentStates = incidentStates.filter((link) =>
    isKnownLinkRef(context.ontology, link.ref)
  )
  const missingEndpoints = new Map<string, OntologyObjectRef>()
  for (const link of knownIncidentStates) {
    for (const ref of [link.ref.source, link.ref.target]) {
      if (!state.objects.has(objectRefKey(ref))) missingEndpoints.set(objectRefKey(ref), ref)
    }
  }

  if (missingEndpoints.size > 0) {
    await mergeLoadedState(context, storage, session, state, {
      objects: [...missingEndpoints.values()],
      links: [],
      linkScopes: [],
      incidentObjects: [],
      points: [],
    })
  }

  const relevantStates = knownIncidentStates.filter((link) => {
    if (link.effective) return true
    if (
      revivingObjects.has(objectRefKey(link.ref.source)) ||
      revivingObjects.has(objectRefKey(link.ref.target))
    ) {
      return true
    }
    if (linkCardinality(context.ontology, link.ref) === "one") {
      return Boolean(
        resolveEffectiveLinkSlotMember({
          ref: link.ref,
          source: link.source,
          override: usableLinkSlotOverride(link.slotOverride),
          endpointExists: (ref) => {
            const object = state.objects.get(objectRefKey(ref))
            return Boolean(object && resolveObject(context.ontology, object))
          },
        })
      )
    }
    return Boolean(resolveLinkEdge(context.ontology, workingLinkEdgeFromState(link), state.objects))
  })
  const missingScopes = distinctCardinalityOneScopes(
    context.ontology,
    relevantStates,
    state.links.scopeSnapshots
  )
  if (missingScopes.length > 0) {
    await mergeLoadedState(context, storage, session, state, {
      objects: [],
      links: [],
      linkScopes: missingScopes,
      incidentObjects: [],
      points: [],
    })
  }

  await mergeMissingLinkSlotEndpoints(context, storage, session, state)

  for (const link of relevantStates) {
    if (linkCardinality(context.ontology, link.ref) === "one") continue
    const key = linkRefKey(link.ref)
    if (state.links.edges.has(key)) continue
    state.links.edges.set(key, workingLinkEdgeFromState(link))
  }
  context.observeCoreBuffer?.(
    "edits.incident-links",
    state.links.edges.size + state.links.slots.size
  )
}

async function mergeMissingLinkSlotEndpoints(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState
): Promise<void> {
  const missing = new Map<string, OntologyObjectRef>()
  for (const working of state.links.slots.values()) {
    const refs = [
      working.ref.source,
      working.source?.assertion.ref.target,
      working.override?.target,
      working.before?.ref.target,
    ]
    for (const ref of refs) {
      if (ref && !state.objects.has(objectRefKey(ref))) missing.set(objectRefKey(ref), ref)
    }
  }
  if (missing.size === 0) return
  await mergeLoadedState(context, storage, session, state, {
    objects: [...missing.values()],
    links: [],
    linkScopes: [],
    incidentObjects: [],
    points: [],
  })
}

async function mergeLoadedState(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  request: MaterializationStateRequestChunk
): Promise<void> {
  const loaded = await loadState(context, storage, session, request)
  mergeWorkingState(context.ontology, state, loaded)
}
