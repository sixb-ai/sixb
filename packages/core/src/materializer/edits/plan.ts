import type { EventActor } from "../../events/envelope"
import type {
  EffectiveLinkChange,
  EffectiveObjectChange,
  OntologyMaterializationOrigin,
} from "../../materialization/model"
import {
  linkRefKey,
  linkRefSortKey,
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
import { diffEffectiveLink, diffEffectiveObject } from "../effective/diff"
import { validateEffectiveObject } from "../effective/validate"
import { stageWorkBounded } from "../execution/work-executor"
import {
  appendLinkEffectivePlan,
  appendLinkOverridePlan,
  appendObjectEffectivePlan,
  appendObjectOverridePlan,
  classificationWork,
  eventWork,
  planWork,
} from "../execution/work-records"
import type { TimedCommitIdentity } from "../shared/identity"
import type { EditWorkingState } from "./operations"
import {
  resolveLink,
  resolveObject,
  validateWorkingCardinality,
  type WorkingLink,
  type WorkingObject,
} from "./working-state"

export interface EditPlanChanges {
  readonly objects: readonly EffectiveObjectChange[]
  readonly links: readonly EffectiveLinkChange[]
}

interface EditPlanContext {
  readonly identity: TimedCommitIdentity
  readonly origin: OntologyMaterializationOrigin
  readonly actor?: EventActor
}

export async function stageEditPlan(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  state: EditWorkingState,
  planContext: EditPlanContext
): Promise<EditPlanChanges> {
  validateWorkingCardinality(context.ontology, state.objects, state.links, state.scopeSnapshots)

  const objectChanges: EffectiveObjectChange[] = []
  for (const working of sortedObjects(state.objects)) {
    const change = await stageObjectPlan(context, storage, session, working, planContext)
    if (change) objectChanges.push(change)
  }

  const linkChanges: EffectiveLinkChange[] = []
  for (const working of sortedLinks(state.links)) {
    const change = await stageLinkPlan(
      context,
      storage,
      session,
      state.objects,
      working,
      planContext
    )
    if (change) linkChanges.push(change)
  }

  return { objects: objectChanges, links: linkChanges }
}

async function stageObjectPlan(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  working: WorkingObject,
  planContext: EditPlanContext
): Promise<EffectiveObjectChange | null> {
  const items: MaterializationPlanWorkItem[] = []
  appendObjectOverridePlan(items, working, planContext.identity)

  const resolved = resolveObject(context.ontology, working)
  if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)
  const change = diffEffectiveObject({
    before: working.before,
    resolved,
    commitId: planContext.identity.commitId,
    committedAt: planContext.identity.committedAt,
  })
  if (change) appendObjectEffectivePlan(items, change)

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

async function stageLinkPlan(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  objects: EditWorkingState["objects"],
  working: WorkingLink,
  planContext: EditPlanContext
): Promise<EffectiveLinkChange | null> {
  const items: MaterializationPlanWorkItem[] = []
  appendLinkOverridePlan(items, working, planContext.identity)

  const resolved = resolveLink(context.ontology, working, objects)
  const change = diffEffectiveLink({
    before: working.before,
    resolved,
    commitId: planContext.identity.commitId,
    committedAt: planContext.identity.committedAt,
  })
  if (change) appendLinkEffectivePlan(items, change)

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
  }
  if (planContext.actor === undefined) return base
  return { ...base, actor: planContext.actor }
}

function sortedObjects(objects: EditWorkingState["objects"]): WorkingObject[] {
  return [...objects.values()].sort((left, right) =>
    compareSortKeys(objectRefSortKey(left.ref), objectRefSortKey(right.ref))
  )
}

function sortedLinks(links: EditWorkingState["links"]): WorkingLink[] {
  return [...links.values()].sort((left, right) =>
    compareSortKeys(linkRefSortKey(left.ref), linkRefSortKey(right.ref))
  )
}

function compareSortKeys(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
