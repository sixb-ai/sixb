import type {
  EffectiveLinkChange,
  EffectiveObjectChange,
  TelemetryPointWrite,
} from "../../materialization/model"
import { linkRefSortKey, objectRefSortKey, telemetryPointSortKey } from "../../materialization/refs"
import type { OntologyMaterializationEventDraft } from "../../storage/ontology"
import { materializationEventKindOrdinal } from "../shared/identity"

export interface OrderedMaterializationEventDraft {
  readonly kindRank: number
  readonly sortKey: string
  readonly draft: OntologyMaterializationEventDraft
}

export function buildObjectMaterializationEventDraft(
  change: EffectiveObjectChange
): OrderedMaterializationEventDraft {
  return orderedDraft(objectRefSortKey(change.ref), buildObjectEventDraft(change))
}

function buildObjectEventDraft(change: EffectiveObjectChange): OntologyMaterializationEventDraft {
  const identity = { objectTypeId: change.ref.objectTypeId, primaryId: change.ref.primaryId }
  switch (change.kind) {
    case "created":
      return {
        type: "object.created",
        payload: { ...identity, properties: change.after.properties },
      }
    case "updated":
      return {
        type: "object.updated",
        payload: {
          ...identity,
          properties: change.after.properties,
          propertyChanges: change.propertyChanges,
        },
      }
    case "deleted":
      return {
        type: "object.deleted",
        payload: { ...identity, propertyChanges: change.propertyChanges },
      }
  }
}

export function buildLinkMaterializationEventDraft(
  change: EffectiveLinkChange
): OrderedMaterializationEventDraft {
  return orderedDraft(linkRefSortKey(change.ref), buildLinkEventDraft(change))
}

function buildLinkEventDraft(change: EffectiveLinkChange): OntologyMaterializationEventDraft {
  const identity = {
    sourceTypeId: change.ref.source.objectTypeId,
    sourceId: change.ref.source.primaryId,
    linkId: change.ref.linkId,
    targetTypeId: change.ref.target.objectTypeId,
    targetId: change.ref.target.primaryId,
  }
  if (change.kind === "deleted") {
    return {
      type: "link.deleted",
      payload: { ...identity, propertyChanges: change.propertyChanges },
    }
  }
  const properties =
    change.after.properties === undefined ? {} : { properties: change.after.properties }
  if (change.kind === "created") {
    return { type: "link.created", payload: { ...identity, ...properties } }
  }
  return {
    type: "link.updated",
    payload: { ...identity, ...properties, propertyChanges: change.propertyChanges },
  }
}

export function buildTelemetryMaterializationEventDraft(
  point: TelemetryPointWrite
): OrderedMaterializationEventDraft {
  const payload = {
    objectTypeId: point.series.object.objectTypeId,
    objectId: point.series.object.primaryId,
    propertyId: point.series.propertyId,
    value: point.value,
    at: point.at,
    ...(point.unit === undefined ? {} : { unit: point.unit }),
  }
  return orderedDraft(telemetryPointSortKey(point.series, point.at), {
    type: "telemetry.appended",
    payload,
  })
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
