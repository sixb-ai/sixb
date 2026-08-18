import type { EventActor } from "../../events/envelope"
import type {
  EffectiveLinkChange,
  EffectiveObjectChange,
  OntologyMaterializationOrigin,
  TelemetryPointWrite,
} from "../../materialization/model"
import { linkRefSortKey, objectRefSortKey, telemetryPointSortKey } from "../../materialization/refs"
import type {
  OntologyMaterializationEvent,
  OntologyMaterializationEventDraft,
} from "../../storage/ontology"
import { createEventId, materializationEventKindOrdinal } from "../shared/identity"

export interface OrderedMaterializationEventDraft {
  readonly kindRank: number
  readonly sortKey: string
  readonly draft: OntologyMaterializationEventDraft
}

export interface MaterializationEventDraftContext {
  readonly projectId: string
  readonly commitId: string
  readonly committedAt: string
  readonly correlationId: string
  readonly origin: OntologyMaterializationOrigin
  readonly actor?: EventActor
}

export function buildObjectMaterializationEventDraft(
  input: MaterializationEventDraftContext & { readonly change: EffectiveObjectChange }
): OrderedMaterializationEventDraft {
  const draft = buildObjectEventDraft(input, input.change)
  return orderedDraft(objectRefSortKey(input.change.ref), draft)
}

function buildObjectEventDraft(
  context: MaterializationEventDraftContext,
  change: EffectiveObjectChange
): OntologyMaterializationEventDraft {
  const base = eventDraftBase(context)
  const partitionKey = `${change.ref.objectTypeId}:${change.ref.primaryId}`

  if (change.kind === "deleted") {
    return {
      ...base,
      type: "object.deleted",
      topic: "objects",
      partitionKey,
      payload: {
        objectTypeId: change.ref.objectTypeId,
        primaryId: change.ref.primaryId,
        propertyChanges: change.propertyChanges,
      },
    }
  }

  const type = objectEventType(change)
  return {
    ...base,
    type,
    topic: "objects",
    partitionKey,
    payload: {
      objectTypeId: change.ref.objectTypeId,
      primaryId: change.ref.primaryId,
      properties: change.after.properties,
      propertyChanges: change.propertyChanges,
    },
  }
}

function objectEventType(
  change: Exclude<EffectiveObjectChange, { readonly kind: "deleted" }>
): "object.created" | "object.updated" {
  if (change.kind === "created") return "object.created"
  return "object.updated"
}

export function buildLinkMaterializationEventDraft(
  input: MaterializationEventDraftContext & { readonly change: EffectiveLinkChange }
): OrderedMaterializationEventDraft {
  const draft = buildLinkEventDraft(input, input.change)
  return orderedDraft(linkRefSortKey(input.change.ref), draft)
}

function buildLinkEventDraft(
  context: MaterializationEventDraftContext,
  change: EffectiveLinkChange
): OntologyMaterializationEventDraft {
  const base = eventDraftBase(context)
  const partitionKey = `${change.ref.source.objectTypeId}:${change.ref.source.primaryId}:${change.ref.linkId}`
  const commonPayload = {
    sourceTypeId: change.ref.source.objectTypeId,
    sourceId: change.ref.source.primaryId,
    linkId: change.ref.linkId,
    targetTypeId: change.ref.target.objectTypeId,
    targetId: change.ref.target.primaryId,
    propertyChanges: change.propertyChanges,
  }

  if (change.kind === "deleted") {
    return {
      ...base,
      type: "link.deleted",
      topic: "links",
      partitionKey,
      payload: commonPayload,
    }
  }

  const type = linkEventType(change)
  if (change.after.properties === undefined) {
    return { ...base, type, topic: "links", partitionKey, payload: commonPayload }
  }
  return {
    ...base,
    type,
    topic: "links",
    partitionKey,
    payload: { ...commonPayload, properties: change.after.properties },
  }
}

function linkEventType(
  change: Exclude<EffectiveLinkChange, { readonly kind: "deleted" }>
): "link.created" | "link.updated" {
  if (change.kind === "created") return "link.created"
  return "link.updated"
}

export function buildTelemetryMaterializationEventDraft(
  input: MaterializationEventDraftContext & { readonly point: TelemetryPointWrite }
): OrderedMaterializationEventDraft {
  const draft = buildTelemetryEventDraft(input, input.point)
  return orderedDraft(telemetryPointSortKey(input.point.series, input.point.at), draft)
}

function buildTelemetryEventDraft(
  context: MaterializationEventDraftContext,
  point: TelemetryPointWrite
): OntologyMaterializationEventDraft {
  const base = eventDraftBase(context)
  const partitionKey = `${point.series.object.objectTypeId}:${point.series.object.primaryId}:${point.series.propertyId}`
  const payload = {
    objectTypeId: point.series.object.objectTypeId,
    objectId: point.series.object.primaryId,
    propertyId: point.series.propertyId,
    value: point.value,
    at: point.at,
  }
  if (point.unit === undefined) {
    return { ...base, type: "telemetry.appended", topic: "telemetry", partitionKey, payload }
  }
  return {
    ...base,
    type: "telemetry.appended",
    topic: "telemetry",
    partitionKey,
    payload: { ...payload, unit: point.unit },
  }
}

function eventDraftBase(context: MaterializationEventDraftContext) {
  const base = {
    schemaVersion: 1 as const,
    projectId: context.projectId,
    occurredAt: context.committedAt,
    correlationId: context.correlationId,
    origin: context.origin,
    commitId: context.commitId,
  }
  if (context.actor === undefined) return base
  return { ...base, actor: context.actor }
}

function orderedDraft(
  sortKey: string,
  draft: OntologyMaterializationEventDraft
): OrderedMaterializationEventDraft {
  return {
    kindRank: materializationEventKindOrdinal(draft.type),
    sortKey,
    draft,
  }
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
  return { ...draft, ...sequence }
}
