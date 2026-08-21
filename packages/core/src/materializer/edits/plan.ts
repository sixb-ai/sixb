import type { EventActor } from "../../events/envelope"
import type {
  EffectiveLinkChange,
  EffectiveObjectChange,
  OntologyMaterializationOrigin,
} from "../../materialization/model"
import {
  compareLinkRefs,
  compareObjectRefs,
  linkRefKey,
  linkRefSortKey,
  linkScopeKey,
  linkScopeSortKey,
  objectRefKey,
  objectRefSortKey,
} from "../../materialization/refs"
import type {
  MaterializationPlanWorkItem,
  MaterializationSession,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import {
  buildLinkMaterializationEventDraft,
  buildObjectMaterializationEventDraft,
} from "../effective/build-events"
import { diffEffectiveLink, diffEffectiveLinkSlot, diffEffectiveObject } from "../effective/diff"
import { validateEffectiveObject } from "../effective/validate"
import { stageWorkBounded } from "../execution/work-executor"
import {
  appendEffectiveLinkWork,
  appendEffectiveObjectWork,
  appendLinkEdgeOverrideWork,
  appendLinkSlotOverrideWork,
  appendObjectOverrideWork,
  classificationWork,
  eventWork,
  planWork,
} from "../execution/work-records"
import type { TimedCommitIdentity } from "../shared/identity"
import {
  type EditWorkingState,
  resolveLinkEdge,
  resolveLinkSlot,
  resolveObject,
  validateWorkingCardinality,
  type WorkingLinkEdge,
  type WorkingLinkSlot,
  type WorkingObject,
} from "./working-state"

export interface EditPlanChanges {
  readonly objects: readonly EffectiveObjectChange[]
  readonly links: readonly EffectiveLinkChange[]
}

interface EditPlanContext {
  readonly identity: TimedCommitIdentity
  readonly origin: OntologyMaterializationOrigin
  readonly correlationId: string
  readonly actor?: EventActor
}

export async function stageEditPlan(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  planContext: EditPlanContext
): Promise<EditPlanChanges> {
  validateWorkingCardinality(state.links.slots)

  const objectChanges: EffectiveObjectChange[] = []
  for (const working of sortedObjects(state.objects)) {
    const change = await stageObject(context, storage, session, working, planContext)
    if (change) objectChanges.push(change)
  }

  const linkChanges: EffectiveLinkChange[] = []
  for (const working of sortedLinkEdges(state.links.edges)) {
    const change = await stageLinkEdge(
      context,
      storage,
      session,
      state.objects,
      working,
      planContext
    )
    if (change) linkChanges.push(change)
  }
  for (const working of sortedLinkSlots(state.links.slots)) {
    linkChanges.push(
      ...(await stageLinkSlot(context, storage, session, state.objects, working, planContext))
    )
  }

  return { objects: objectChanges, links: linkChanges }
}

/**
 * Stages one slot-level authority change and translates it back to physical edge writes/events.
 * Replacing the selected target therefore becomes an ordered delete of the old edge followed by a
 * create of the new edge, while the override itself remains keyed only by `(source, linkId)`.
 */
async function stageLinkSlot(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  objects: EditWorkingState["objects"],
  working: WorkingLinkSlot,
  planContext: EditPlanContext
): Promise<EffectiveLinkChange[]> {
  const overrideItems: MaterializationPlanWorkItem[] = []
  appendLinkSlotOverrideWork(overrideItems, working, planContext.identity)
  const resolved = resolveLinkSlot(context.ontology, working, objects)
  const changes = diffEffectiveLinkSlot({
    before: working.before,
    resolved,
    commitId: planContext.identity.commitId,
    committedAt: planContext.identity.committedAt,
  })

  const representative =
    resolved?.ref ??
    working.before?.ref ??
    (working.override
      ? {
          source: working.ref.source,
          linkId: working.ref.linkId,
          target: working.override.target,
        }
      : null)
  const scopeSortKey = linkScopeSortKey(working.ref.source, working.ref.linkId)
  const work: MaterializationWorkRecord[] = overrideItems.map((item) =>
    planWork(item, scopeSortKey)
  )
  if (representative) {
    work.push(
      classificationWork("link", linkRefKey(representative), linkRefSortKey(representative))
    )
  }
  for (const change of changes) {
    const effectiveItems: MaterializationPlanWorkItem[] = []
    appendEffectiveLinkWork(effectiveItems, change)
    const sortKey = linkRefSortKey(change.ref)
    work.push(...effectiveItems.map((item) => planWork(item, sortKey)))
    work.push(eventWork(buildLinkEvent(context, planContext, change)))
  }
  await stageWorkBounded(context, storage, session, work)
  return changes
}

async function stageObject(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  working: WorkingObject,
  planContext: EditPlanContext
): Promise<EffectiveObjectChange | null> {
  const items: MaterializationPlanWorkItem[] = []
  appendObjectOverrideWork(items, working, planContext.identity)

  const resolved = resolveObject(context.ontology, working)
  if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)
  const change = diffEffectiveObject({
    before: working.before,
    resolved,
    commitId: planContext.identity.commitId,
    committedAt: planContext.identity.committedAt,
  })
  if (change) appendEffectiveObjectWork(items, change)

  const sortKey = objectRefSortKey(working.ref)
  const work: MaterializationWorkRecord[] = [
    classificationWork("object", objectRefKey(working.ref), sortKey),
    ...items.map((item) => planWork(item, sortKey)),
  ]
  if (change) {
    work.push(eventWork(buildObjectEvent(context, planContext, change)))
  }
  await stageWorkBounded(context, storage, session, work)
  return change
}

async function stageLinkEdge(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  objects: EditWorkingState["objects"],
  working: WorkingLinkEdge,
  planContext: EditPlanContext
): Promise<EffectiveLinkChange | null> {
  const items: MaterializationPlanWorkItem[] = []
  appendLinkEdgeOverrideWork(items, working, planContext.identity)

  const resolved = resolveLinkEdge(context.ontology, working, objects)
  const change = diffEffectiveLink({
    before: working.before,
    resolved,
    commitId: planContext.identity.commitId,
    committedAt: planContext.identity.committedAt,
  })
  if (change) appendEffectiveLinkWork(items, change)

  const sortKey = linkRefSortKey(working.ref)
  const work: MaterializationWorkRecord[] = [
    classificationWork("link", linkRefKey(working.ref), sortKey),
    ...items.map((item) => planWork(item, sortKey)),
  ]
  if (change) {
    work.push(eventWork(buildLinkEvent(context, planContext, change)))
  }
  await stageWorkBounded(context, storage, session, work)
  return change
}

function buildObjectEvent(
  context: Pick<MaterializerContext, "projectId">,
  planContext: EditPlanContext,
  change: EffectiveObjectChange
) {
  const eventContext = materializationEventContext(context, planContext)
  return buildObjectMaterializationEventDraft({ ...eventContext, change })
}

function buildLinkEvent(
  context: Pick<MaterializerContext, "projectId">,
  planContext: EditPlanContext,
  change: EffectiveLinkChange
) {
  const eventContext = materializationEventContext(context, planContext)
  return buildLinkMaterializationEventDraft({ ...eventContext, change })
}

function materializationEventContext(
  context: Pick<MaterializerContext, "projectId">,
  planContext: EditPlanContext
) {
  const base = {
    projectId: context.projectId,
    commitId: planContext.identity.commitId,
    committedAt: planContext.identity.committedAt,
    origin: planContext.origin,
    correlationId: planContext.correlationId,
  }
  if (planContext.actor === undefined) return base
  return { ...base, actor: planContext.actor }
}

function sortedObjects(objects: EditWorkingState["objects"]): WorkingObject[] {
  return [...objects.values()].sort((left, right) => compareObjectRefs(left.ref, right.ref))
}

function sortedLinkEdges(edges: EditWorkingState["links"]["edges"]): WorkingLinkEdge[] {
  return [...edges.values()].sort((left, right) => compareLinkRefs(left.ref, right.ref))
}

function sortedLinkSlots(slots: EditWorkingState["links"]["slots"]): WorkingLinkSlot[] {
  return [...slots.values()].sort((left, right) =>
    linkScopeKey(left.ref.source, left.ref.linkId).localeCompare(
      linkScopeKey(right.ref.source, right.ref.linkId)
    )
  )
}
