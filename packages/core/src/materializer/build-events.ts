import type { EventActor } from "../events/envelope"
import type {
  OntologyMaterializationEvent,
  OntologyMaterializationEventDraft,
} from "../storage/ontology"
import { createEventId, materializationEventKindOrdinal } from "./identity"
import { linkRefSortKey, objectRefSortKey, telemetryPointSortKey } from "./refs"
import type {
  EffectiveLinkChange,
  EffectiveObjectChange,
  OntologyMaterializationOrigin,
  TelemetryPointWrite,
} from "./types"

export interface ChangedTelemetryPoint {
  readonly point: TelemetryPointWrite
}

export interface OrderedMaterializationEventDraft {
  readonly kindRank: number
  readonly sortKey: string
  readonly draft: OntologyMaterializationEventDraft
}

export function buildMaterializationEventDrafts(input: {
  readonly projectId: string
  readonly commitId: string
  readonly committedAt: string
  readonly origin: OntologyMaterializationOrigin
  readonly actor?: EventActor
  readonly objects: readonly EffectiveObjectChange[]
  readonly links: readonly EffectiveLinkChange[]
  readonly points: readonly ChangedTelemetryPoint[]
}): readonly OrderedMaterializationEventDraft[] {
  const base = {
    schemaVersion: 1 as const,
    projectId: input.projectId,
    occurredAt: input.committedAt,
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    origin: input.origin,
    commitId: input.commitId,
  }
  const drafts: OrderedMaterializationEventDraft[] = []
  for (const change of input.objects) {
    const draft: OntologyMaterializationEventDraft =
      change.kind === "deleted"
        ? {
            ...base,
            type: "object.deleted",
            topic: "objects",
            partitionKey: `${change.ref.objectTypeId}:${change.ref.primaryId}`,
            payload: {
              objectTypeId: change.ref.objectTypeId,
              primaryId: change.ref.primaryId,
              propertyChanges: change.propertyChanges,
            },
          }
        : {
            ...base,
            type: change.kind === "created" ? "object.created" : "object.updated",
            topic: "objects",
            partitionKey: `${change.ref.objectTypeId}:${change.ref.primaryId}`,
            payload: {
              objectTypeId: change.ref.objectTypeId,
              primaryId: change.ref.primaryId,
              properties: change.after.properties,
              propertyChanges: change.propertyChanges,
            },
          }
    drafts.push({
      kindRank: materializationEventKindOrdinal(draft.type),
      sortKey: objectRefSortKey(change.ref),
      draft,
    })
  }
  for (const change of input.links) {
    const partitionKey = `${change.ref.source.objectTypeId}:${change.ref.source.primaryId}:${change.ref.linkId}`
    const draft: OntologyMaterializationEventDraft =
      change.kind === "deleted"
        ? {
            ...base,
            type: "link.deleted",
            topic: "links",
            partitionKey,
            payload: {
              sourceTypeId: change.ref.source.objectTypeId,
              sourceId: change.ref.source.primaryId,
              linkId: change.ref.linkId,
              targetTypeId: change.ref.target.objectTypeId,
              targetId: change.ref.target.primaryId,
              propertyChanges: change.propertyChanges,
            },
          }
        : {
            ...base,
            type: change.kind === "created" ? "link.created" : "link.updated",
            topic: "links",
            partitionKey,
            payload: {
              sourceTypeId: change.ref.source.objectTypeId,
              sourceId: change.ref.source.primaryId,
              linkId: change.ref.linkId,
              targetTypeId: change.ref.target.objectTypeId,
              targetId: change.ref.target.primaryId,
              ...(change.after.properties !== undefined
                ? { properties: change.after.properties }
                : {}),
              propertyChanges: change.propertyChanges,
            },
          }
    drafts.push({
      kindRank: materializationEventKindOrdinal(draft.type),
      sortKey: linkRefSortKey(change.ref),
      draft,
    })
  }
  for (const { point } of input.points) {
    const type = "telemetry.appended" as const
    drafts.push({
      kindRank: materializationEventKindOrdinal(type),
      sortKey: telemetryPointSortKey(point.series, point.at),
      draft: {
        ...base,
        type,
        topic: "telemetry",
        partitionKey: `${point.series.object.objectTypeId}:${point.series.object.primaryId}:${point.series.propertyId}`,
        payload: {
          objectTypeId: point.series.object.objectTypeId,
          objectId: point.series.object.primaryId,
          propertyId: point.series.propertyId,
          value: point.value,
          ...(point.unit !== undefined ? { unit: point.unit } : {}),
          at: point.at,
        },
      },
    })
  }
  return drafts
}

export function sequenceMaterializationEvent(
  projectId: string,
  commitId: string,
  commitOrdinal: number,
  draft: OntologyMaterializationEventDraft
): OntologyMaterializationEvent {
  const sequence = {
    id: createEventId(projectId, commitId, commitOrdinal),
    commitOrdinal,
  }
  switch (draft.type) {
    case "object.created":
    case "object.updated":
      return { ...draft, ...sequence }
    case "object.deleted":
      return { ...draft, ...sequence }
    case "link.created":
    case "link.updated":
      return { ...draft, ...sequence }
    case "link.deleted":
      return { ...draft, ...sequence }
    case "telemetry.appended":
      return { ...draft, ...sequence }
  }
}
