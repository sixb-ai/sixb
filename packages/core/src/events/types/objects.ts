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

export type ObjectEvent = ObjectUpsertedEvent
