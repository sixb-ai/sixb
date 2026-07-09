import {
  type DomainEvent,
  type EventSelectorSpec,
  type StoredDomainEvent,
  scopeKeysForEvent,
} from "@sixb/core"
import type { OrchestratorRouteKey } from "./types"

/**
 * Only place in the runtime that knows how to extract a routing id from a
 * specific event payload. Extending to a new event type = one case here.
 */
export function routeKeyForEvent(event: StoredDomainEvent): OrchestratorRouteKey | null {
  switch (event.type) {
    case "schedule.triggered":
      return `schedule.triggered:${event.payload.scheduleId}`
    case "sync.run.finished":
      return `sync.run.finished:${event.payload.syncId}:${event.payload.status}`
    case "pipeline.run.finished":
      return `pipeline.run.finished:${event.payload.pipelineId}:${event.payload.status}`
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
  const triggerKey = triggerRouteKeyForEvent(event)
  if (triggerKey) {
    keys.push(triggerKey)
  }
  return keys
}

export function triggerRouteKeyForSelector(
  eventType: DomainEvent["type"],
  selector: EventSelectorSpec<unknown>
): OrchestratorRouteKey | null {
  return triggerRouteKey(eventType, selector.topic, selector)
}

function triggerRouteKeyForEvent(event: StoredDomainEvent): OrchestratorRouteKey | null {
  return triggerRouteKey(event.type, event.topic, scopeKeysForEvent(event))
}

function triggerRouteKey(
  eventType: DomainEvent["type"],
  topic: DomainEvent["topic"] | undefined,
  scope: {
    readonly objectTypeId?: string
    readonly linkId?: string
    readonly ruleId?: string
    readonly actionId?: string
  }
): OrchestratorRouteKey | null {
  switch (topic) {
    case "objects":
      return scope.objectTypeId ? `trigger:${eventType}:${scope.objectTypeId}` : null
    case "links":
      return scope.objectTypeId && scope.linkId
        ? `trigger:${eventType}:${scope.objectTypeId}:${scope.linkId}`
        : null
    case "rules":
      return scope.ruleId ? `trigger:${eventType}:${scope.ruleId}` : null
    case "actions":
      return scope.actionId ? `trigger:${eventType}:${scope.actionId}` : null
    default:
      return null
  }
}
