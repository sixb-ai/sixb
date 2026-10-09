import type { Redactions } from "../../security/types"
import type { EventEnvelope } from "../envelope"
import type { PropertyChangeMap } from "../property-changes"

export interface ObjectMutationEventPayload<TValue = unknown> {
  objectTypeId: string
  primaryId: string
  properties: Record<string, TValue>
  propertyChanges: PropertyChangeMap<TValue>
  /** Properties omitted for this reader, which lacks their clearance. Never stored. */
  redactions?: Redactions
}

export interface ObjectDeletedEventPayload<TValue = unknown> {
  objectTypeId: string
  primaryId: string
  propertyChanges: PropertyChangeMap<TValue>
  /** Properties omitted for this reader, which lacks their clearance. Never stored. */
  redactions?: Redactions
}

export interface ObjectCreatedEvent extends EventEnvelope {
  type: "object.created"
  topic: "objects"
  partitionKey: string
  payload: ObjectMutationEventPayload
}

export interface ObjectUpdatedEvent extends EventEnvelope {
  type: "object.updated"
  topic: "objects"
  partitionKey: string
  payload: ObjectMutationEventPayload
}

export interface ObjectDeletedEvent extends EventEnvelope {
  type: "object.deleted"
  topic: "objects"
  partitionKey: string
  payload: ObjectDeletedEventPayload
}

export type ObjectEvent = ObjectCreatedEvent | ObjectUpdatedEvent | ObjectDeletedEvent
