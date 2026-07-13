import type { EventEnvelope } from "../envelope"
import type { PropertyChangeMap } from "../property-changes"

export interface ObjectCreatedEvent extends EventEnvelope {
  type: "object.created"
  topic: "objects"
  partitionKey: string
  payload: {
    objectTypeId: string
    primaryId: string
    properties: Record<string, unknown>
    propertyChanges: PropertyChangeMap
  }
}

export interface ObjectUpdatedEvent extends EventEnvelope {
  type: "object.updated"
  topic: "objects"
  partitionKey: string
  payload: {
    objectTypeId: string
    primaryId: string
    properties: Record<string, unknown>
    propertyChanges: PropertyChangeMap
  }
}

export interface ObjectDeletedEvent extends EventEnvelope {
  type: "object.deleted"
  topic: "objects"
  partitionKey: string
  payload: {
    objectTypeId: string
    primaryId: string
    propertyChanges: PropertyChangeMap
  }
}

export type ObjectEvent = ObjectCreatedEvent | ObjectUpdatedEvent | ObjectDeletedEvent
