import type { OntologyObjectRef } from "../../materialization/model"
import { linkRefKey, objectRefKey } from "../../materialization/refs"
import type {
  MaterializationLinkState,
  MaterializationSession,
  MaterializationStateRequestChunk,
  OntologyMaterializationStorage,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { loadState, oneStateRequest } from "../effective/load-state"
import type { EditWorkingState } from "./operations"
import { buildEditReadSet, isKnownLinkRef } from "./read-set"
import {
  distinctCardinalityOneScopes,
  mergeWorkingState,
  resolveLink,
  workingLinkFromState,
} from "./working-state"

export async function loadEditWorkingState(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  operations: Parameters<typeof buildEditReadSet>[1]
): Promise<EditWorkingState> {
  const state: EditWorkingState = {
    objects: new Map(),
    links: new Map(),
    scopeSnapshots: new Map(),
  }
  const readSet = buildEditReadSet(context.ontology, operations)
  const explicitLinkKeys = new Set(readSet.links.map(linkRefKey))
  const incidentLinks = new Map<string, MaterializationLinkState>()
  const ignoredLinks: EditWorkingState["links"] = new Map()
  const revivingObjects = new Set(
    operations.filter(isRevivingObjectOperation).map((operation) => objectRefKey(operation.ref))
  )

  for await (const page of storage.streamState({
    session,
    requests: oneStateRequest(readSet),
    pageRows: context.batching.statePageRows,
  })) {
    mergeWorkingState(state.objects, ignoredLinks, state.scopeSnapshots, page)
    for (const link of page.links) {
      const key = linkRefKey(link.ref)
      if (explicitLinkKeys.has(key) && !state.links.has(key)) {
        state.links.set(key, workingLinkFromState(link))
      }
      if (readSet.incidentObjects.length > 0) incidentLinks.set(key, link)
    }
  }

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
    return Boolean(resolveLink(context.ontology, workingLinkFromState(link), state.objects))
  })
  const missingScopes = distinctCardinalityOneScopes(
    context.ontology,
    relevantStates,
    state.scopeSnapshots
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

  for (const link of relevantStates) {
    const key = linkRefKey(link.ref)
    if (state.links.has(key)) continue
    state.links.set(key, workingLinkFromState(link))
  }
  context.observeCoreBuffer?.("edits.incident-links", state.links.size)
}

async function mergeLoadedState(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  request: MaterializationStateRequestChunk
): Promise<void> {
  const loaded = await loadState(context, storage, session, request)
  mergeWorkingState(state.objects, state.links, state.scopeSnapshots, loaded)
}
