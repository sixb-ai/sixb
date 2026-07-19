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
  SourceReplacementObjectState,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import {
  buildLinkMaterializationEventDraft,
  buildObjectMaterializationEventDraft,
} from "../effective/build-events"
import { diffEffectiveLink, diffEffectiveObject } from "../effective/diff"
import { oneStateRequest } from "../effective/load-state"
import { resolveEffectiveLink, resolveEffectiveObject } from "../effective/resolve"
import { validateEffectiveObject } from "../effective/validate"
import { stageWorkBounded, validateStagedCardinality } from "../execution/work-executor"
import {
  appendLinkEffectivePlan,
  appendObjectEffectivePlan,
  classificationWork,
  eventWork,
  planWork,
} from "../execution/work-records"
import type { TimedCommitIdentity } from "../shared/identity"
import { throwIfAborted } from "./source-materialization"

export interface ProjectionReplacementPlanInput {
  readonly source: ProjectionSourceRef
  readonly materializationId: string
  readonly projectionKind: "object" | "link"
  readonly identity: TimedCommitIdentity
  readonly origin: OntologyMaterializationOrigin
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
    for await (const page of storage.streamSourceReplacementState({
      session,
      source: input.source,
      candidateMaterializationId: input.materializationId,
      entityKind: "object",
      pageRows: context.batching.statePageRows,
    })) {
      throwIfAborted(input.signal)
      const work: MaterializationWorkRecord[] = []
      for (const state of page.objects) {
        const resolvedValue = resolveReplacementObject(context, state)
        if (resolvedValue) {
          validateEffectiveObject(context.ontology, resolvedValue.ref, resolvedValue.properties)
        }
        const change = diffEffectiveObject({
          before: state.effective,
          resolved: resolvedValue,
          commitId: input.identity.commitId,
          committedAt: input.identity.committedAt,
        })
        const sortKey = objectRefSortKey(state.ref)
        work.push(classificationWork("object", objectRefKey(state.ref), sortKey))
        work.push({
          kind: "object-existence",
          recordKey: `existence:${sortKey}`,
          ref: state.ref,
          exists: resolvedValue !== null,
        })
        if (Boolean(state.effective) !== Boolean(resolvedValue)) {
          work.push({
            kind: "incident-object",
            recordKey: `incident:${sortKey}`,
            ref: state.ref,
          })
        }
        if (change) {
          incrementObjectCount(counts, change.kind)
          const items: MaterializationPlanWorkItem[] = []
          appendObjectEffectivePlan(items, change)
          for (const item of items) work.push(planWork(item, sortKey))
          work.push(
            eventWork(
              buildObjectMaterializationEventDraft({
                projectId: context.projectId,
                commitId: input.identity.commitId,
                committedAt: input.identity.committedAt,
                origin: input.origin,
                change,
              })
            )
          )
        } else {
          counts.objectsUnchanged += 1
        }
      }
      await stageWorkBounded(context, storage, session, work)
    }
  }

  for await (const page of storage.streamSourceReplacementState({
    session,
    source: input.source,
    candidateMaterializationId: input.materializationId,
    entityKind: "link",
    pageRows: context.batching.statePageRows,
  })) {
    throwIfAborted(input.signal)
    const endpointRefs = new Map<string, OntologyObjectRef>()
    for (const state of page.links) {
      endpointRefs.set(objectRefKey(state.ref.source), state.ref.source)
      endpointRefs.set(objectRefKey(state.ref.target), state.ref.target)
    }
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
    if (missingEndpoints.length > 0) {
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
    }
    const work: MaterializationWorkRecord[] = []
    for (const state of page.links) {
      const resolvedValue = state.diffRequired
        ? resolveEffectiveLink({
            ref: state.ref,
            source: state.candidateSource,
            override: state.override?.value ?? null,
            sourceEndpointExists: endpointExistence.get(objectRefKey(state.ref.source)) ?? false,
            targetEndpointExists: endpointExistence.get(objectRefKey(state.ref.target)) ?? false,
          })
        : state.effective
      const definition = context.ontology
        .resolveObjectType(state.ref.source.objectTypeId)
        .links.find((candidate) => candidate.id === state.ref.linkId)
      if (definition?.cardinality === "one") {
        const scopeSortKey = linkScopeSortKey(state.ref.source, state.ref.linkId)
        const linkSortKey = linkRefSortKey(state.ref)
        work.push({
          kind: "cardinality",
          recordKey: `cardinality:${scopeSortKey}:${linkSortKey}`,
          scopeSortKey,
          linkSortKey,
          ref: state.ref,
          occupied: resolvedValue !== null,
        })
      }
      if (state.diffRequired) {
        const change = diffEffectiveLink({
          before: state.effective,
          resolved: resolvedValue,
          commitId: input.identity.commitId,
          committedAt: input.identity.committedAt,
        })
        const sortKey = linkRefSortKey(state.ref)
        work.push(classificationWork("link", linkRefKey(state.ref), sortKey))
        if (change) {
          incrementLinkCount(counts, change.kind)
          const items: MaterializationPlanWorkItem[] = []
          appendLinkEffectivePlan(items, change)
          for (const item of items) work.push(planWork(item, sortKey))
          work.push(
            eventWork(
              buildLinkMaterializationEventDraft({
                projectId: context.projectId,
                commitId: input.identity.commitId,
                committedAt: input.identity.committedAt,
                origin: input.origin,
                change,
              })
            )
          )
        } else {
          counts.linksUnchanged += 1
        }
      }
    }
    await stageWorkBounded(context, storage, session, work)
  }

  await validateStagedCardinality(context, storage, session, input.signal)
  return counts
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
