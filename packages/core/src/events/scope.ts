import type { DomainEvent } from "./types/index"

/**
 * The scope keys an event can be matched against by a subscription filter.
 *
 * Object identity lives in different payload fields per topic (objects use
 * `objectTypeId`/`primaryId`, telemetry uses `objectId`, links use the source
 * side), so this resolves them topic-aware. It is the single source of truth
 * shared by the client predicate (`buildEventPredicate`) and the server poll
 * filter (`eventMatchesScope`) so the two can never drift — adding a topic is a
 * compile error here until this switch is extended.
 */
export interface EventScopeKeys {
  readonly objectTypeId?: string
  readonly primaryId?: string
  readonly propertyId?: string
  readonly linkId?: string
  readonly runId?: string
}

export function scopeKeysForEvent(event: DomainEvent): EventScopeKeys {
  switch (event.topic) {
    case "objects":
      return { objectTypeId: event.payload.objectTypeId, primaryId: event.payload.primaryId }
    case "telemetry":
      return {
        objectTypeId: event.payload.objectTypeId,
        primaryId: event.payload.objectId,
        propertyId: event.payload.propertyId,
      }
    case "links":
      return {
        objectTypeId: event.payload.sourceTypeId,
        primaryId: event.payload.sourceId,
        linkId: event.payload.linkId,
      }
    case "workflows":
    case "pipelines":
    case "syncs":
      return { runId: event.payload.runId }
    case "actions":
    case "schedules":
    case "datasets":
    case "rules":
      return {}
    default: {
      // Exhaustiveness guard: a new topic must extend the switch above.
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}
