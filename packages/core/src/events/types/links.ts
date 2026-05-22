import type { EventEnvelope } from "../envelope"

export interface LinkUpsertedEvent extends EventEnvelope {
  type: "link.upserted"
  topic: "links"
  partitionKey: string
  payload: {
    sourceTypeId: string
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
    properties?: Record<string, unknown>
  }
}

export interface LinkRemovedEvent extends EventEnvelope {
  type: "link.removed"
  topic: "links"
  partitionKey: string
  payload: {
    sourceTypeId: string
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
  }
}

export type LinkEvent = LinkUpsertedEvent | LinkRemovedEvent
