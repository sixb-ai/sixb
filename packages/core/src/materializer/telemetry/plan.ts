import type { EventActor } from "../../events/envelope"
import { stableJsonStringify } from "../../json"
import { MaterializationObjectNotFoundError } from "../../materialization/errors"
import type {
  OntologyMaterializationOrigin,
  OntologyObjectRef,
  TelemetryAppend,
  TelemetryPointWrite,
} from "../../materialization/model"
import {
  objectRefKey,
  objectRefSortKey,
  telemetryPointKey,
  telemetryPointSortKey,
} from "../../materialization/refs"
import type {
  MaterializationObjectState,
  MaterializationPlanWorkItem,
  MaterializationSession,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
  StoredTelemetryPoint,
} from "../../storage/ontology"
import type { MaterializerContext } from "../context"
import { resolveObject, type WorkingObject, workingObjectFromState } from "../edits/working-state"
import {
  buildObjectMaterializationEventDraft,
  buildTelemetryMaterializationEventDraft,
} from "../effective/build-events"
import { diffEffectiveObject } from "../effective/diff"
import { loadState, oneStateRequest } from "../effective/load-state"
import { validateEffectiveObject } from "../effective/validate"
import { stageWorkBounded } from "../execution/work-executor"
import {
  appendEffectiveObjectWork,
  classificationWork,
  eventWork,
  planWork,
} from "../execution/work-records"
import type { TimedCommitIdentity } from "../shared/identity"

export interface TelemetryPlanCounts {
  readonly pointsCreated: number
  readonly pointsUpdated: number
  readonly pointsUnchanged: number
  readonly latestObjectsChanged: number
}

interface MutableTelemetryPlanCounts {
  pointsCreated: number
  pointsUpdated: number
  pointsUnchanged: number
  latestObjectsChanged: number
}

interface TelemetryObjectGroup {
  readonly objectRef: OntologyObjectRef
  readonly start: number
  readonly end: number
}

interface TelemetryPlanContext {
  readonly input: TelemetryAppend
  readonly identity: TimedCommitIdentity
  readonly origin: OntologyMaterializationOrigin
  readonly event: TelemetryEventContext
}

interface TelemetryEventContext {
  readonly correlationId: string
  readonly actor?: EventActor
}

export async function planTelemetryAppend(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  input: TelemetryAppend,
  identity: TimedCommitIdentity,
  origin: OntologyMaterializationOrigin,
  event: TelemetryEventContext
): Promise<TelemetryPlanCounts> {
  const counts = emptyTelemetryCounts()
  const planContext = { input, identity, origin, event }
  const objects = await loadTelemetryObjects(context, storage, session, input.points)
  const existingPoints = await loadExistingPoints(context, storage, session, input.points)
  for (const group of telemetryObjectGroups(input.points)) {
    const storedObject = objects.get(objectRefKey(group.objectRef))
    if (!storedObject?.effective) {
      throw new MaterializationObjectNotFoundError(
        group.objectRef.objectTypeId,
        group.objectRef.primaryId
      )
    }
    await planTelemetryObject(
      context,
      storage,
      session,
      planContext,
      group,
      workingObjectFromState(storedObject),
      existingPoints,
      counts
    )
  }
  return counts
}

function* telemetryObjectGroups(
  points: readonly TelemetryPointWrite[]
): Iterable<TelemetryObjectGroup> {
  let start = 0
  while (start < points.length) {
    const objectRef = points[start].series.object
    const objectKey = objectRefKey(objectRef)
    let end = start + 1
    while (end < points.length && objectRefKey(points[end].series.object) === objectKey) {
      end += 1
    }
    yield { objectRef, start, end }
    start = end
  }
}

async function planTelemetryObject(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  planContext: TelemetryPlanContext,
  group: TelemetryObjectGroup,
  working: WorkingObject,
  existingPoints: ReadonlyMap<string, StoredTelemetryPoint>,
  counts: MutableTelemetryPlanCounts
): Promise<void> {
  const latest = new Map(working.latestTelemetry.map((point) => [point.series.propertyId, point]))

  for (let start = group.start; start < group.end; start += context.batching.statePageRows) {
    const end = Math.min(group.end, start + context.batching.statePageRows)
    const points = planContext.input.points.slice(start, end)
    const work = planTelemetryChunk(context, planContext, points, existingPoints, latest, counts)
    await stageWorkBounded(context, storage, session, work)
  }

  working.latestTelemetry = [...latest.values()]
  await stageTelemetryObjectPlan(context, storage, session, planContext, working, counts)
}

async function loadTelemetryObjects(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  points: readonly TelemetryPointWrite[]
): Promise<ReadonlyMap<string, MaterializationObjectState>> {
  const refs = new Map<string, OntologyObjectRef>()
  for (const point of points) refs.set(objectRefKey(point.series.object), point.series.object)
  const objectState = await loadState(context, storage, session, {
    objects: [...refs.values()],
    links: [],
    linkScopes: [],
    incidentObjects: [],
    points: [],
  })
  return new Map(objectState.objects.map((object) => [objectRefKey(object.ref), object]))
}

function planTelemetryChunk(
  context: Pick<MaterializerContext, "projectId">,
  planContext: TelemetryPlanContext,
  points: readonly TelemetryPointWrite[],
  existingPoints: ReadonlyMap<string, StoredTelemetryPoint>,
  latest: Map<string, StoredTelemetryPoint>,
  counts: MutableTelemetryPlanCounts
): MaterializationWorkRecord[] {
  const work: MaterializationWorkRecord[] = []
  for (const point of points) {
    work.push(...planTelemetryPoint(context, planContext, point, existingPoints, latest, counts))
  }
  return work
}

async function loadExistingPoints(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  points: readonly TelemetryPointWrite[]
): Promise<ReadonlyMap<string, StoredTelemetryPoint>> {
  const existingPoints = new Map<string, StoredTelemetryPoint>()
  for await (const page of storage.streamState({
    session,
    requests: oneStateRequest({
      objects: [],
      links: [],
      linkScopes: [],
      incidentObjects: [],
      points: points.map((point) => ({ series: point.series, at: point.at })),
    }),
    pageRows: context.batching.statePageRows,
  })) {
    for (const existing of page.points) {
      existingPoints.set(telemetryPointKey(existing.series, existing.at), existing)
    }
  }
  context.observeCoreBuffer?.("telemetry.existing-points", existingPoints.size)
  return existingPoints
}

function planTelemetryPoint(
  context: Pick<MaterializerContext, "projectId">,
  planContext: TelemetryPlanContext,
  point: TelemetryPointWrite,
  existingPoints: ReadonlyMap<string, StoredTelemetryPoint>,
  latest: Map<string, StoredTelemetryPoint>,
  counts: MutableTelemetryPlanCounts
): MaterializationWorkRecord[] {
  const identityKey = telemetryPointKey(point.series, point.at)
  const sortKey = telemetryPointSortKey(point.series, point.at)
  const existing = existingPoints.get(identityKey)
  const unchanged = telemetryPointUnchanged(existing, point)
  const work: MaterializationWorkRecord[] = [classificationWork("point", identityKey, sortKey)]

  if (unchanged) {
    counts.pointsUnchanged += 1
  } else {
    countTelemetryPointChange(counts, existing)
    work.push(planWork(telemetryPointUpsert(point, existing, planContext.identity), sortKey))
    work.push(eventWork(buildTelemetryEvent(context, planContext, point)))
  }

  updateLatestPoint(latest, point, existing, unchanged, planContext.identity)
  return work
}

function telemetryPointUnchanged(
  existing: StoredTelemetryPoint | undefined,
  point: TelemetryPointWrite
): boolean {
  if (!existing) return false
  return (
    stableJsonStringify({ value: existing.value, unit: existing.unit ?? null }) ===
    stableJsonStringify({ value: point.value, unit: point.unit ?? null })
  )
}

function countTelemetryPointChange(
  counts: MutableTelemetryPlanCounts,
  existing: StoredTelemetryPoint | undefined
): void {
  if (existing) counts.pointsUpdated += 1
  else counts.pointsCreated += 1
}

function telemetryPointUpsert(
  point: TelemetryPointWrite,
  existing: StoredTelemetryPoint | undefined,
  identity: TimedCommitIdentity
): MaterializationPlanWorkItem {
  const storedPoint = {
    series: point.series,
    value: point.value,
    at: point.at,
    lastCommitId: identity.commitId,
  }
  const pointWithUnit = storedTelemetryPointWithUnit(storedPoint, point.unit)
  return {
    kind: "point-upsert",
    value: {
      point: pointWithUnit,
      expected: {
        series: point.series,
        at: point.at,
        lastCommitId: existing?.lastCommitId ?? null,
      },
    },
  }
}

function storedTelemetryPointWithUnit<T extends object>(
  point: T,
  unit: string | undefined
): T | (T & { readonly unit: string }) {
  if (unit === undefined) return point
  return { ...point, unit }
}

function buildTelemetryEvent(
  context: Pick<MaterializerContext, "projectId">,
  planContext: TelemetryPlanContext,
  point: TelemetryPointWrite
) {
  const eventContext = telemetryEventContext(context, planContext)
  return buildTelemetryMaterializationEventDraft({ ...eventContext, point })
}

function updateLatestPoint(
  latest: Map<string, StoredTelemetryPoint>,
  point: TelemetryPointWrite,
  existing: StoredTelemetryPoint | undefined,
  unchanged: boolean,
  identity: TimedCommitIdentity
): void {
  const current = latest.get(point.series.propertyId)
  if (current && point.at < current.at) return

  let lastCommitId = identity.commitId
  if (unchanged && existing) lastCommitId = existing.lastCommitId
  const storedPoint = {
    series: point.series,
    value: point.value,
    at: point.at,
    lastCommitId,
  }
  if (point.unit === undefined) {
    latest.set(point.series.propertyId, storedPoint)
    return
  }
  latest.set(point.series.propertyId, { ...storedPoint, unit: point.unit })
}

async function stageTelemetryObjectPlan(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  planContext: TelemetryPlanContext,
  working: WorkingObject,
  counts: MutableTelemetryPlanCounts
): Promise<void> {
  const resolved = resolveObject(context.ontology, working)
  if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)
  const change = diffEffectiveObject({
    before: working.before,
    resolved,
    commitId: planContext.identity.commitId,
    committedAt: planContext.identity.committedAt,
  })
  const sortKey = objectRefSortKey(working.ref)
  const work: MaterializationWorkRecord[] = [
    classificationWork("object", objectRefKey(working.ref), sortKey),
  ]
  if (change) {
    counts.latestObjectsChanged += 1
    const items: MaterializationPlanWorkItem[] = []
    appendEffectiveObjectWork(items, change)
    work.push(...items.map((item) => planWork(item, sortKey)))
    const eventContext = telemetryEventContext(context, planContext)
    work.push(eventWork(buildObjectMaterializationEventDraft({ ...eventContext, change })))
  }
  await stageWorkBounded(context, storage, session, work)
}

function telemetryEventContext(
  context: Pick<MaterializerContext, "projectId">,
  planContext: TelemetryPlanContext
) {
  const eventContext = {
    projectId: context.projectId,
    commitId: planContext.identity.commitId,
    committedAt: planContext.identity.committedAt,
    origin: planContext.origin,
    correlationId: planContext.event.correlationId,
  }
  if (planContext.event.actor === undefined) return eventContext
  return { ...eventContext, actor: planContext.event.actor }
}

function emptyTelemetryCounts(): MutableTelemetryPlanCounts {
  return {
    pointsCreated: 0,
    pointsUpdated: 0,
    pointsUnchanged: 0,
    latestObjectsChanged: 0,
  }
}
