import type {
  EffectiveLinkChange,
  EffectiveObjectChange,
  ObjectOverride,
} from "../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
  linkScopeSortKey,
  objectRefKey,
  objectRefSortKey,
  utf8JsonByteLength,
} from "../../materialization/refs"
import type {
  ExactObjectOverrideWrite,
  MaterializationPlanWorkItem,
  MaterializationWorkRecord,
  OntologyCommitWrite,
  OntologyReplacementPlanStorage,
  PlannedReplacementIdentity,
  ReplacementPlanRef,
  SourceReplacementLinkState,
  SourceReplacementObjectState,
  StageReplacementPlanInput,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import {
  buildLinkMaterializationEventDraft,
  buildObjectMaterializationEventDraft,
} from "../effective/build-events"
import { diffEffectiveLink, diffEffectiveObject } from "../effective/diff"
import {
  resolveEffectiveLink,
  resolveEffectiveLinkSlotMember,
  resolveEffectiveObject,
  storedObjectEditedAt,
  usableLinkSlotOverride,
} from "../effective/resolve"
import { validateEffectiveObject } from "../effective/validate"
import {
  appendArtifactHolderWork,
  appendEffectiveLinkWork,
  appendEffectiveObjectWork,
  appendUniqueValueWork,
  classificationWork,
  eventWork,
  planWork,
} from "../execution/work-records"
import { throwIfAborted } from "../shared/abort"
import { chunkBySize } from "../shared/chunking"

export interface ProjectionReplacementPlanInput {
  readonly projectionKind: "object" | "link"
  /** The commit the plan carries, timed as the plan was opened. */
  readonly commit: OntologyCommitWrite
  /** An object an edit created before this instant, and that the dataset misses, is withdrawn. */
  readonly withdrawCreatesBefore?: string
  readonly signal?: AbortSignal
}

/**
 * Plans every identity of the candidate's durable plan still to plan, outside any transaction.
 * Objects come first: a link resolves against the existence its endpoints are planned to have.
 */
export async function planProjectionReplacement(
  context: MaterializerContext,
  plans: OntologyReplacementPlanStorage,
  plan: ReplacementPlanRef,
  input: ProjectionReplacementPlanInput
): Promise<void> {
  const staged = { ...plan, commit: input.commit }
  if (input.projectionKind === "object") {
    for await (const page of plans.streamState({
      ...plan,
      entityKind: "object",
      pageRows: context.batching.statePageRows,
    })) {
      throwIfAborted(input.signal)
      await stagePlanned(
        context,
        plans,
        staged,
        page.objects.map((state) => ({
          identity: { kind: "object", ref: state.ref },
          records: planReplacementObject(context, input, state),
        }))
      )
    }
  }
  for await (const page of plans.streamState({
    ...plan,
    entityKind: "link",
    pageRows: context.batching.statePageRows,
  })) {
    throwIfAborted(input.signal)
    const endpoints = new Map(
      page.endpoints.map((endpoint) => [objectRefKey(endpoint.ref), endpoint.exists] as const)
    )
    await stagePlanned(
      context,
      plans,
      staged,
      page.links.map((state) => ({
        identity: { kind: "link", ref: state.ref },
        records: planReplacementLink(context, input, state, endpoints),
      }))
    )
  }
}

async function stagePlanned(
  context: Pick<MaterializerContext, "batching">,
  plans: OntologyReplacementPlanStorage,
  plan: Omit<StageReplacementPlanInput, "planned">,
  planned: readonly PlannedReplacementIdentity[]
): Promise<void> {
  for await (const chunk of chunkBySize(planned, {
    maxRows: context.batching.planChunkRows,
    maxBytes: context.batching.planChunkBytes,
    byteLength: (value) => utf8JsonByteLength(value.records),
  })) {
    await plans.stage({ ...plan, planned: chunk })
  }
}

function planReplacementObject(
  context: MaterializerContext,
  input: ProjectionReplacementPlanInput,
  state: SourceReplacementObjectState
): MaterializationWorkRecord[] {
  const withdrawn = withdrawnCreate(input, state)
  const override = withdrawn ? withdrawn.value : (state.override?.value ?? null)
  const resolved = resolveReplacementObject(context, state, override)
  if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)

  const change = diffEffectiveObject({
    before: state.effective,
    resolved,
    commitId: input.commit.id,
    committedAt: input.commit.committedAt,
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

  if (withdrawn) {
    work.push(planWork({ kind: "object-override-upsert", value: withdrawn }, sortKey))
  }

  if (!change) return work
  appendObjectChangeWork(context, work, sortKey, change)
  return work
}

function appendObjectChangeWork(
  context: Pick<MaterializerContext, "ontology">,
  work: MaterializationWorkRecord[],
  sortKey: string,
  change: EffectiveObjectChange
): void {
  const items: MaterializationPlanWorkItem[] = []
  appendEffectiveObjectWork(items, change)
  for (const item of items) work.push(planWork(item, sortKey))
  appendUniqueValueWork(work, change, context.ontology)
  appendArtifactHolderWork(work, change, context.ontology)
  work.push(eventWork(buildObjectMaterializationEventDraft(change)))
}

function planReplacementLink(
  context: MaterializerContext,
  input: ProjectionReplacementPlanInput,
  state: SourceReplacementLinkState,
  endpointExistence: ReadonlyMap<string, boolean>
): MaterializationWorkRecord[] {
  const resolved = resolveReplacementLink(context, state, endpointExistence)
  const work = cardinalityWork(context, state, resolved !== null)
  if (!state.diffRequired) return work

  const change = diffEffectiveLink({
    before: state.effective,
    resolved,
    commitId: input.commit.id,
    committedAt: input.commit.committedAt,
  })
  const sortKey = linkRefSortKey(state.ref)
  work.push(classificationWork("link", linkRefKey(state.ref), sortKey))
  if (!change) return work
  appendLinkChangeWork(work, sortKey, change)
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
  change: EffectiveLinkChange
): void {
  const items: MaterializationPlanWorkItem[] = []
  appendEffectiveLinkWork(items, change)
  for (const item of items) work.push(planWork(item, sortKey))
  work.push(eventWork(buildLinkMaterializationEventDraft(change)))
}

/**
 * An edit's create gives its object existence until the source is read after it. A dataset read
 * later that does not hold the object decides: the create becomes a patch, as an edit of a source
 * object would. It keeps every value the edits set and leaves existence to the source, so the
 * object goes like any object its projection withdraws, and comes back with those values if the
 * dataset holds it again. An edit after the read keeps the create until the next one.
 */
function withdrawnCreate(
  input: ProjectionReplacementPlanInput,
  state: SourceReplacementObjectState
): ExactObjectOverrideWrite | null {
  const { withdrawCreatesBefore } = input
  const override = state.override
  if (!withdrawCreatesBefore || state.candidateSource) return null
  if (override?.value.kind !== "create" || override.updatedAt >= withdrawCreatesBefore) return null

  return {
    ref: state.ref,
    value: { kind: "patch", set: override.value.properties, unset: [] },
    editedAt: storedObjectEditedAt(override),
    expectedLastCommitId: override.lastCommitId,
    lastCommitId: input.commit.id,
    updatedAt: input.commit.committedAt,
  }
}

function resolveReplacementObject(
  context: Pick<MaterializerContext, "ontology">,
  state: SourceReplacementObjectState,
  override: ObjectOverride | null
) {
  return resolveEffectiveObject({
    ref: state.ref,
    primaryPropertyId: context.ontology.getPrimaryPropertyId(state.ref.objectTypeId),
    source: state.candidateSource,
    override,
    editedAt: storedObjectEditedAt(state.override),
    latestTelemetry: state.latestTelemetry,
  })
}
