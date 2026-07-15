import type { DomainEvent, EventSelectorSpec } from "@sixb/core"
import { scopeKeysForEvent } from "@sixb/core/events/scope"
import type { StoredDomainEvent } from "@sixb/core/internal/events"
import type { OrchestratorRouteKey } from "./types"

/**
 * Only place in the runtime that knows how to extract a routing id from a
 * specific event payload. Extending to a new event type = one case here.
 */
export function routeKeyForEvent(event: StoredDomainEvent): OrchestratorRouteKey | null {
  switch (event.type) {
    case "schedule.triggered":
      return `schedule.triggered:${event.payload.scheduleId}`
    case "dataset.version.committed":
      return `dataset.version.committed:${event.payload.datasetId}`
    default:
      return null
  }
}

export function routeKeysForEvent(event: StoredDomainEvent): readonly OrchestratorRouteKey[] {
  const keys: OrchestratorRouteKey[] = []
  const staticKey = routeKeyForEvent(event)
  if (staticKey) {
    keys.push(staticKey)
  }
  const eventScheduleKey = eventScheduleRouteKeyForEvent(event)
  if (eventScheduleKey) {
    keys.push(eventScheduleKey)
  }
  return keys
}

export function eventScheduleRouteKeyForSelector(
  eventType: DomainEvent["type"],
  selector: EventSelectorSpec<unknown>
): OrchestratorRouteKey | null {
  return eventScheduleRouteKey(eventType, selector.topic, selector)
}

function eventScheduleRouteKeyForEvent(event: StoredDomainEvent): OrchestratorRouteKey | null {
  return eventScheduleRouteKey(event.type, event.topic, scopeKeysForEvent(event))
}

function eventScheduleRouteKey(
  eventType: DomainEvent["type"],
  topic: DomainEvent["topic"] | undefined,
  scope: {
    readonly objectTypeId?: string
    readonly linkId?: string
    readonly ruleId?: string
    readonly actionId?: string
    readonly datasetId?: string
    readonly syncId?: string
    readonly pipelineId?: string
  }
): OrchestratorRouteKey | null {
  switch (topic) {
    case "objects":
      return scope.objectTypeId ? `event-schedule:${eventType}:${scope.objectTypeId}` : null
    case "links":
      return scope.objectTypeId && scope.linkId
        ? `event-schedule:${eventType}:${scope.objectTypeId}:${scope.linkId}`
        : null
    case "rules":
      return scope.ruleId ? `event-schedule:${eventType}:${scope.ruleId}` : null
    case "actions":
      return scope.actionId ? `event-schedule:${eventType}:${scope.actionId}` : null
    case "datasets":
      return scope.datasetId ? `event-schedule:${eventType}:${scope.datasetId}` : null
    case "syncs":
      return scope.syncId ? `event-schedule:${eventType}:${scope.syncId}` : null
    case "pipelines":
      return scope.pipelineId ? `event-schedule:${eventType}:${scope.pipelineId}` : null
    default:
      return null
  }
}
