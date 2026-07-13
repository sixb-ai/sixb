import type { EventEnvelope } from "../envelope"
import type { PropertyChangeMap } from "../property-changes"

export interface LinkCreatedEvent extends EventEnvelope {
  type: "link.created"
  topic: "links"
  partitionKey: string
  payload: {
    sourceTypeId: string
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
    properties?: Record<string, unknown>
    propertyChanges: PropertyChangeMap
  }
}

export interface LinkUpdatedEvent extends EventEnvelope {
  type: "link.updated"
  topic: "links"
  partitionKey: string
  payload: {
    sourceTypeId: string
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
    properties?: Record<string, unknown>
    propertyChanges: PropertyChangeMap
  }
}

export interface LinkDeletedEvent extends EventEnvelope {
  type: "link.deleted"
  topic: "links"
  partitionKey: string
  payload: {
    sourceTypeId: string
    sourceId: string
    linkId: string
    targetTypeId: string
    targetId: string
    propertyChanges: PropertyChangeMap
  }
}

export type LinkEvent = LinkCreatedEvent | LinkUpdatedEvent | LinkDeletedEvent
