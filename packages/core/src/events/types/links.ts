import type { EventEnvelope } from "../envelope"
import type { PropertyChangeMap } from "../property-changes"

export interface LinkUpsertedEvent extends EventEnvelope {
  /**
   * @deprecated Legacy compatibility event. Use `link.created` or
   * `link.updated` instead. To be removed in the final migration phase.
   */
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
  /**
   * @deprecated Legacy compatibility event. Use `link.deleted` instead.
   * To be removed in the final migration phase.
   */
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

export type LinkEvent =
  | LinkUpsertedEvent
  | LinkRemovedEvent
  | LinkCreatedEvent
  | LinkUpdatedEvent
  | LinkDeletedEvent
