import type { EventEnvelope } from "../envelope"
import type { PropertyChangeMap } from "../property-changes"

interface LinkEventSubject {
  sourceTypeId: string
  sourceId: string
  linkId: string
  targetTypeId: string
  targetId: string
}

export interface LinkMutationEventPayload<TValue = unknown> extends LinkEventSubject {
  properties?: Record<string, TValue>
  propertyChanges: PropertyChangeMap<TValue>
}

export interface LinkDeletedEventPayload<TValue = unknown> extends LinkEventSubject {
  propertyChanges: PropertyChangeMap<TValue>
}

export interface LinkCreatedEvent extends EventEnvelope {
  type: "link.created"
  topic: "links"
  partitionKey: string
  payload: LinkMutationEventPayload
}

export interface LinkUpdatedEvent extends EventEnvelope {
  type: "link.updated"
  topic: "links"
  partitionKey: string
  payload: LinkMutationEventPayload
}

export interface LinkDeletedEvent extends EventEnvelope {
  type: "link.deleted"
  topic: "links"
  partitionKey: string
  payload: LinkDeletedEventPayload
}

export type LinkEvent = LinkCreatedEvent | LinkUpdatedEvent | LinkDeletedEvent
