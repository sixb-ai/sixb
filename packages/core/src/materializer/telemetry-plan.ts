import { stableJsonStringify } from "../json"
import type {
  MaterializationPlanWorkItem,
  MaterializationSession,
  MaterializationWorkRecord,
  OntologyMaterializationStorage,
  StoredTelemetryPoint,
} from "../storage/ontology"
import {
  buildObjectMaterializationEventDraft,
  buildTelemetryMaterializationEventDraft,
} from "./build-events"
import { diffEffectiveObject } from "./diff-effective"
import { resolveObject, workingObjectFromState } from "./edit-working-state"
import { MaterializationValidationError } from "./errors"
import type { FixedCommitIdentity } from "./identity"
import { loadState, oneStateRequest } from "./load-state"
import type { MaterializerContext } from "./materializer-context"
import { objectRefKey, objectRefSortKey, telemetryPointKey, telemetryPointSortKey } from "./refs"
import type { OntologyMaterializationOrigin, TelemetryAppend } from "./types"
import { validateEffectiveObject } from "./validate-effective"
import { stageWorkBounded } from "./work-executor"
import { appendObjectEffectivePlan, classificationWork, eventWork, planWork } from "./work-records"

export interface TelemetryPlanCounts {
  readonly pointsCreated: number
  readonly pointsUpdated: number
  readonly pointsUnchanged: number
  readonly latestObjectsChanged: number
}

export async function planTelemetryAppend(
  context: MaterializerContext,
  storage: OntologyMaterializationStorage,
  session: MaterializationSession,
  input: TelemetryAppend,
  identity: FixedCommitIdentity,
  origin: OntologyMaterializationOrigin
): Promise<TelemetryPlanCounts> {
  let pointsCreated = 0
  let pointsUpdated = 0
  let pointsUnchanged = 0
  let latestObjectsChanged = 0
  let groupStart = 0
  while (groupStart < input.points.length) {
    const objectRef = input.points[groupStart].series.object
    const objectKey = objectRefKey(objectRef)
    let groupEnd = groupStart + 1
    while (
      groupEnd < input.points.length &&
      objectRefKey(input.points[groupEnd].series.object) === objectKey
    ) {
      groupEnd += 1
    }
    const objectState = await loadState(context, storage, session, {
      objects: [objectRef],
      links: [],
      linkScopes: [],
      incidentObjects: [],
      points: [],
    })
    const storedObject = objectState.objects[0]
    if (!storedObject) {
      throw new MaterializationValidationError("Telemetry object state was not loaded.")
    }
    const working = workingObjectFromState(storedObject)
    const latest = new Map(working.latestTelemetry.map((point) => [point.series.propertyId, point]))
    for (
      let chunkStart = groupStart;
      chunkStart < groupEnd;
      chunkStart += context.batching.statePageRows
    ) {
      const points = input.points.slice(
        chunkStart,
        Math.min(groupEnd, chunkStart + context.batching.statePageRows)
      )
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
      const pointWork: MaterializationWorkRecord[] = []
      for (const point of points) {
        const identityKey = telemetryPointKey(point.series, point.at)
        const sortKey = telemetryPointSortKey(point.series, point.at)
        const existing = existingPoints.get(identityKey)
        const unchanged = Boolean(
          existing &&
            stableJsonStringify({ value: existing.value, unit: existing.unit ?? null }) ===
              stableJsonStringify({ value: point.value, unit: point.unit ?? null })
        )
        pointWork.push(classificationWork("point", identityKey, sortKey))
        if (unchanged) {
          pointsUnchanged += 1
        } else {
          if (existing) pointsUpdated += 1
          else pointsCreated += 1
          const item: MaterializationPlanWorkItem = {
            kind: "point-upsert",
            value: {
              point: {
                series: point.series,
                value: point.value,
                ...(point.unit !== undefined ? { unit: point.unit } : {}),
                at: point.at,
                lastCommitId: identity.commitId,
              },
              expected: {
                series: point.series,
                at: point.at,
                lastCommitId: existing?.lastCommitId ?? null,
              },
            },
          }
          pointWork.push(planWork(item, sortKey))
          pointWork.push(
            eventWork(
              buildTelemetryMaterializationEventDraft({
                projectId: context.projectId,
                commitId: identity.commitId,
                committedAt: identity.committedAt,
                origin,
                ...(input.actor !== undefined ? { actor: input.actor } : {}),
                point,
              })
            )
          )
        }
        const current = latest.get(point.series.propertyId)
        if (!current || point.at >= current.at) {
          latest.set(point.series.propertyId, {
            series: point.series,
            value: point.value,
            ...(point.unit !== undefined ? { unit: point.unit } : {}),
            at: point.at,
            lastCommitId: unchanged
              ? (existing?.lastCommitId ?? identity.commitId)
              : identity.commitId,
          })
        }
      }
      await stageWorkBounded(context, storage, session, pointWork)
    }
    working.latestTelemetry = [...latest.values()]
    const resolved = resolveObject(context.ontology, working)
    if (resolved) validateEffectiveObject(context.ontology, resolved.ref, resolved.properties)
    const change = diffEffectiveObject({
      before: working.before,
      resolved,
      commitId: identity.commitId,
      committedAt: identity.committedAt,
    })
    const sortKey = objectRefSortKey(working.ref)
    const objectWork: MaterializationWorkRecord[] = [
      classificationWork("object", objectRefKey(working.ref), sortKey),
    ]
    if (change) {
      latestObjectsChanged += 1
      const items: MaterializationPlanWorkItem[] = []
      appendObjectEffectivePlan(items, change)
      objectWork.push(...items.map((item) => planWork(item, sortKey)))
      objectWork.push(
        eventWork(
          buildObjectMaterializationEventDraft({
            projectId: context.projectId,
            commitId: identity.commitId,
            committedAt: identity.committedAt,
            origin,
            ...(input.actor !== undefined ? { actor: input.actor } : {}),
            change,
          })
        )
      )
    }
    await stageWorkBounded(context, storage, session, objectWork)
    groupStart = groupEnd
  }
  return {
    pointsCreated,
    pointsUpdated,
    pointsUnchanged,
    latestObjectsChanged,
  }
}
