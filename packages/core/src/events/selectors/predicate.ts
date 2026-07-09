import { scopeKeysForEvent } from "../scope"
import type { DomainEvent } from "../types"
import type { EventSelectorSpec } from "./types"

export function eventSelectorSpec(selector: EventSelectorSpec<unknown>): EventSelectorSpec {
  return {
    ...(selector.topic !== undefined ? { topic: selector.topic } : {}),
    ...(selector.types !== undefined ? { types: selector.types } : {}),
    ...(selector.objectTypeId !== undefined ? { objectTypeId: selector.objectTypeId } : {}),
    ...(selector.primaryId !== undefined ? { primaryId: selector.primaryId } : {}),
    ...(selector.propertyId !== undefined ? { propertyId: selector.propertyId } : {}),
    ...(selector.propertyOperation !== undefined
      ? { propertyOperation: selector.propertyOperation }
      : {}),
    ...(selector.linkId !== undefined ? { linkId: selector.linkId } : {}),
    ...(selector.ruleId !== undefined ? { ruleId: selector.ruleId } : {}),
    ...(selector.actionId !== undefined ? { actionId: selector.actionId } : {}),
    ...(selector.runId !== undefined ? { runId: selector.runId } : {}),
  }
}

export function buildEventSelectorPredicate(
  selector: EventSelectorSpec<unknown>
): (event: DomainEvent) => boolean {
  const filter = eventSelectorSpec(selector)

  return (event) => {
    if (filter.topic && event.topic !== filter.topic) return false
    if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) return false

    const scope = scopeKeysForEvent(event)

    if (filter.objectTypeId !== undefined && scope.objectTypeId !== filter.objectTypeId)
      return false
    if (filter.primaryId !== undefined && scope.primaryId !== filter.primaryId) return false
    if (filter.linkId !== undefined && scope.linkId !== filter.linkId) return false
    if (filter.ruleId !== undefined && scope.ruleId !== filter.ruleId) return false
    if (filter.runId !== undefined && scope.runId !== filter.runId) return false
    if (filter.actionId !== undefined && scope.actionId !== filter.actionId) return false

    if (!matchesPropertyChange(event, filter)) return false

    return true
  }
}

function matchesPropertyChange(event: DomainEvent, filter: EventSelectorSpec): boolean {
  if (filter.propertyId === undefined) {
    return filter.propertyOperation === undefined
  }

  if (!hasPropertyChanges(event)) {
    const scope = scopeKeysForEvent(event)
    return filter.propertyOperation === undefined && scope.propertyId === filter.propertyId
  }

  const change = event.payload.propertyChanges[filter.propertyId]
  if (!change) {
    return false
  }

  return filter.propertyOperation === undefined || change.operation === filter.propertyOperation
}

function hasPropertyChanges(event: DomainEvent): event is DomainEvent & {
  payload: { propertyChanges: Record<string, { operation: string }> }
} {
  return (
    event.payload !== null &&
    typeof event.payload === "object" &&
    "propertyChanges" in event.payload
  )
}
