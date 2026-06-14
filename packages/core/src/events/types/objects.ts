import type { EventEnvelope } from "../envelope"

export interface ObjectUpsertedEvent extends EventEnvelope {
  type: "object.upserted"
  topic: "objects"
  partitionKey: string
  payload: {
    objectTypeId: string
    primaryId: string
    properties: Record<string, unknown>
  }
}

export interface ObjectDeletedEvent extends EventEnvelope {
  type: "object.deleted"
  topic: "objects"
  partitionKey: string
  payload: {
    objectTypeId: string
    primaryId: string
  }
}

export type ObjectEvent = ObjectUpsertedEvent | ObjectDeletedEvent
