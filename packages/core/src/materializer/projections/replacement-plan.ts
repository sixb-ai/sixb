import type {
  EffectiveChangeCounts,
  EffectiveLinkChange,
  EffectiveObjectChange,
  OntologyMaterializationOrigin,
  OntologyObjectRef,
  ProjectionSourceRef,
} from "../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  objectRefKey,
  objectRefSortKey,
} from "../../materialization/refs"
import type {
  MaterializationPlanWorkItem,
  MaterializationSession,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
  SourceReplacementStatePage,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import {
  buildLinkMaterializationEventDraft,
  buildObjectMaterializationEventDraft,
} from "../effective/build-events"
import { diffEffectiveLink, diffEffectiveObject } from "../effective/diff"
import { oneStateRequest } from "../effective/load-state"
import {
  resolveEffectiveLink,
  resolveEffectiveLinkSlotMember,
  resolveEffectiveObject,
  storedObjectEditedAt,
  usableLinkSlotOverride,
} from "../effective/resolve"
import { validateEffectiveObject } from "../effective/validate"
import { stageWorkBounded, validateStagedCardinality } from "../execution/work-executor"
import {
  appendEffectiveLinkWork,
  appendEffectiveObjectWork,
  classificationWork,
  eventWork,
  planWork,
} from "../execution/work-records"
import { throwIfAborted } from "../shared/abort"
import type { TimedCommitIdentity } from "../shared/identity"

export interface ProjectionReplacementPlanInput {
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly projectionKind: "object" | "link"
  readonly identity: TimedCommitIdentity
  readonly origin: OntologyMaterializationOrigin
  readonly correlationId: string
  readonly signal?: AbortSignal
}

export async function planProjectionReplacement(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  input: ProjectionReplacementPlanInput
): Promise<EffectiveChangeCounts> {
  const counts = emptyCounts()
  if (input.projectionKind === "object") {
    await planObjectReplacement(context, storage, session, input, counts)
  }
  await planLinkReplacement(context, storage, session, input, counts)
  await validateStagedCardinality(context, storage, session, input.signal)
  return counts
}

async function planObjectReplacement(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  input: ProjectionReplacementPlanInput,
  counts: MutableCounts
): Promise<void> {
  for await (const page of storage.streamSourceReplacementState({
    session,
    source: input.source,
    candidateMaterializationId: input.materializationId,
    entityKind: "object",
    pageRows: context.batching.statePageRows,
  })) {
    throwIfAborted(input.signal)
    const work = planObjectPage(context, input, page, counts)
    await stageWorkBounded(context, storage, session, work)
  }
}

function planObjectPage(
  context: MaterializerContext,
  input: ProjectionReplacementPlanInput,
  page: SourceReplacementStatePage,
  counts: MutableCounts
): MaterializationWorkRecord[] {
  const work: MaterializationWorkRecord[] = []
  for (const state of page.objects) {
    work.push(...planReplacementObject(context, input, state, counts))
  }
  return work
}

function planReplacementObject(
  context: MaterializerContext,
  input: ProjectionReplacementPlanInput,
  state: SourceReplacementObjectState,
  counts: MutableCounts
): MaterializationWorkRecord[] {
  const resolved = resolveReplacementObject(context, state)
  if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)

  const change = diffEffectiveObject({
    before: state.effective,
    resolved,
    commitId: input.identity.commitId,
    committedAt: input.identity.committedAt,
  })
  const sortKey = objectRefSortKey(state.ref)
  const work: MaterializationWorkRecord[] = [
    classificationWork("object", objectRefKey(state.ref), sortKey),
    {
      kind: "object-existence",
      recordKey: `existence:${sortKey}`,
      ref: state.ref,
      exists: resolved !== null,
    },
  ]
  if (Boolean(state.effective) !== Boolean(resolved)) {
    work.push({ kind: "incident-object", recordKey: `incident:${sortKey}`, ref: state.ref })
  }

  if (!change) {
    counts.objectsUnchanged += 1
    return work
  }

  incrementObjectCount(counts, change.kind)
  appendObjectChangeWork(work, sortKey, context, input, change)
  return work
}

function appendObjectChangeWork(
  work: MaterializationWorkRecord[],
  sortKey: string,
  context: Pick<MaterializerContext, "projectId">,
  input: ProjectionReplacementPlanInput,
  change: EffectiveObjectChange
): void {
  const items: MaterializationPlanWorkItem[] = []
  appendEffectiveObjectWork(items, change)
  for (const item of items) work.push(planWork(item, sortKey))
  work.push(
    eventWork(
      buildObjectMaterializationEventDraft({
        projectId: context.projectId,
        commitId: input.identity.commitId,
        committedAt: input.identity.committedAt,
        origin: input.origin,
        correlationId: input.correlationId,
        change,
      })
    )
  )
}

async function planLinkReplacement(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  input: ProjectionReplacementPlanInput,
  counts: MutableCounts
): Promise<void> {
  for await (const page of storage.streamSourceReplacementState({
    session,
    source: input.source,
    candidateMaterializationId: input.materializationId,
    entityKind: "link",
    pageRows: context.batching.statePageRows,
  })) {
    throwIfAborted(input.signal)
    const endpointExistence = await loadEndpointExistence(context, storage, session, page)
    const work = planLinkPage(context, input, page, endpointExistence, counts)
    await stageWorkBounded(context, storage, session, work)
  }
}

async function loadEndpointExistence(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  page: SourceReplacementStatePage
): Promise<ReadonlyMap<string, boolean>> {
  const endpointRefs = collectEndpointRefs(page.links)
  const endpointExistence = new Map<string, boolean>()
  for (const value of await storage.readObjectExistence({
    session,
    refs: [...endpointRefs.values()],
  })) {
    endpointExistence.set(objectRefKey(value.ref), value.exists)
  }

  const missingEndpoints = [...endpointRefs.values()].filter(
    (ref) => !endpointExistence.has(objectRefKey(ref))
  )
  if (missingEndpoints.length === 0) return endpointExistence

  for await (const endpointPage of storage.streamState({
    session,
    requests: oneStateRequest({
      objects: missingEndpoints,
      links: [],
      linkScopes: [],
      incidentObjects: [],
      points: [],
    }),
    pageRows: context.batching.statePageRows,
  })) {
    for (const endpoint of endpointPage.objects) {
      endpointExistence.set(objectRefKey(endpoint.ref), endpoint.effective !== null)
    }
  }
  return endpointExistence
}

function collectEndpointRefs(
  links: readonly SourceReplacementLinkState[]
): ReadonlyMap<string, OntologyObjectRef> {
  const refs = new Map<string, OntologyObjectRef>()
  for (const state of links) {
    refs.set(objectRefKey(state.ref.source), state.ref.source)
    refs.set(objectRefKey(state.ref.target), state.ref.target)
  }
  return refs
}

function planLinkPage(
  context: MaterializerContext,
  input: ProjectionReplacementPlanInput,
  page: SourceReplacementStatePage,
  endpointExistence: ReadonlyMap<string, boolean>,
  counts: MutableCounts
): MaterializationWorkRecord[] {
  const work: MaterializationWorkRecord[] = []
  for (const state of page.links) {
    work.push(...planReplacementLink(context, input, state, endpointExistence, counts))
  }
  return work
}

function planReplacementLink(
  context: MaterializerContext,
  input: ProjectionReplacementPlanInput,
  state: SourceReplacementLinkState,
  endpointExistence: ReadonlyMap<string, boolean>,
  counts: MutableCounts
): MaterializationWorkRecord[] {
  const resolved = resolveReplacementLink(context, state, endpointExistence)
  const work = cardinalityWork(context, state, resolved !== null)
  if (!state.diffRequired) return work

  const change = diffEffectiveLink({
    before: state.effective,
    resolved,
    commitId: input.identity.commitId,
    committedAt: input.identity.committedAt,
  })
  const sortKey = linkRefSortKey(state.ref)
  work.push(classificationWork("link", linkRefKey(state.ref), sortKey))
  if (!change) {
    counts.linksUnchanged += 1
    return work
  }

  incrementLinkCount(counts, change.kind)
  appendLinkChangeWork(work, sortKey, context, input, change)
  return work
}

function resolveReplacementLink(
  context: Pick<MaterializerContext, "ontology">,
  state: SourceReplacementLinkState,
  endpointExistence: ReadonlyMap<string, boolean>
) {
  if (!state.diffRequired) return state.effective
  const definition = context.ontology
    .resolveObjectType(state.ref.source.objectTypeId)
    .links.find((candidate) => candidate.id === state.ref.linkId)
  if (definition?.cardinality === "one") {
    return resolveEffectiveLinkSlotMember({
      ref: state.ref,
      source: state.candidateSource,
      override: usableLinkSlotOverride(state.slotOverride),
      endpointExists: (ref) => endpointExistence.get(objectRefKey(ref)) ?? false,
    })
  }
  return resolveEffectiveLink({
    ref: state.ref,
    source: state.candidateSource,
    override: state.override?.value ?? null,
    sourceEndpointExists: endpointExistence.get(objectRefKey(state.ref.source)) ?? false,
    targetEndpointExists: endpointExistence.get(objectRefKey(state.ref.target)) ?? false,
  })
}

function cardinalityWork(
  context: Pick<MaterializerContext, "ontology">,
  state: SourceReplacementLinkState,
  occupied: boolean
): MaterializationWorkRecord[] {
  const definition = context.ontology
    .resolveObjectType(state.ref.source.objectTypeId)
    .links.find((candidate) => candidate.id === state.ref.linkId)
  if (definition?.cardinality !== "one") return []

  const scopeSortKey = linkScopeSortKey(state.ref.source, state.ref.linkId)
  const linkSortKey = linkRefSortKey(state.ref)
  return [
    {
      kind: "cardinality",
      recordKey: `cardinality:candidate:${scopeSortKey}:${linkSortKey}`,
      view: "candidate",
      scopeSortKey,
      linkSortKey,
      ref: state.ref,
      occupied: state.candidateSource !== null,
    },
    {
      kind: "cardinality",
      recordKey: `cardinality:effective:${scopeSortKey}:${linkSortKey}`,
      view: "effective",
      scopeSortKey,
      linkSortKey,
      ref: state.ref,
      occupied,
    },
  ]
}

function appendLinkChangeWork(
  work: MaterializationWorkRecord[],
  sortKey: string,
  context: Pick<MaterializerContext, "projectId">,
  input: ProjectionReplacementPlanInput,
  change: EffectiveLinkChange
): void {
  const items: MaterializationPlanWorkItem[] = []
  appendEffectiveLinkWork(items, change)
  for (const item of items) work.push(planWork(item, sortKey))
  work.push(
    eventWork(
      buildLinkMaterializationEventDraft({
        projectId: context.projectId,
        commitId: input.identity.commitId,
        committedAt: input.identity.committedAt,
        origin: input.origin,
        correlationId: input.correlationId,
        change,
      })
    )
  )
}

function resolveReplacementObject(
  context: Pick<MaterializerContext, "ontology">,
  state: SourceReplacementObjectState
) {
  return resolveEffectiveObject({
    ref: state.ref,
    primaryPropertyId: context.ontology.getPrimaryPropertyId(state.ref.objectTypeId),
    source: state.candidateSource,
    override: state.override?.value ?? null,
    editedAt: storedObjectEditedAt(state.override),
    latestTelemetry: state.latestTelemetry,
  })
}

function emptyCounts(): MutableCounts {
  return {
    objectsCreated: 0,
    objectsUpdated: 0,
    objectsDeleted: 0,
    objectsUnchanged: 0,
    linksCreated: 0,
    linksUpdated: 0,
    linksDeleted: 0,
    linksUnchanged: 0,
  }
}

type MutableCounts = { -readonly [K in keyof EffectiveChangeCounts]: EffectiveChangeCounts[K] }

function incrementObjectCount(counts: MutableCounts, kind: EffectiveObjectChange["kind"]): void {
  if (kind === "created") counts.objectsCreated += 1
  else if (kind === "updated") counts.objectsUpdated += 1
  else counts.objectsDeleted += 1
}

function incrementLinkCount(counts: MutableCounts, kind: EffectiveLinkChange["kind"]): void {
  if (kind === "created") counts.linksCreated += 1
  else if (kind === "updated") counts.linksUpdated += 1
  else counts.linksDeleted += 1
}
