import { buildEventSelectorPredicate, type EventSelectorSpec } from "../events/selectors"
import type { DomainEvent, PropertyChange, PropertyChangeMap } from "../events/types"
import { evaluatePredicate } from "../predicates"
import type { EventScheduleConditionScope, EventScheduleTriggerDefinition } from "./types"

export type RuntimeEventScheduleContext = Readonly<Record<string, unknown>>

export interface RuntimeEventScheduleDefinition {
  readonly kind: "schedule"
  readonly id: string
  readonly trigger: EventScheduleTriggerDefinition<EventSelectorSpec<unknown>>
}

export interface EventScheduleEvaluationResult<TEvent = unknown> {
  readonly schedule: RuntimeEventScheduleDefinition
  readonly event: TEvent
}

export function eventScheduleSubscribedEventTypes(
  schedule: RuntimeEventScheduleDefinition
): readonly DomainEvent["type"][] {
  return schedule.trigger.source.types ?? []
}

export function evaluateEventSchedule(
  schedule: RuntimeEventScheduleDefinition,
  event: DomainEvent
): EventScheduleEvaluationResult | null {
  if (!buildEventSelectorPredicate(schedule.trigger.source)(event)) {
    return null
  }

  const eventContext = buildEventScheduleContext(event)
  if (!eventContext) {
    return null
  }

  const condition = schedule.trigger.condition
  if (!condition) {
    return {
      schedule,
      event: eventContext,
    }
  }

  const afterProperties = propertiesForScope(event, condition.scope)
  const fields = fieldsForEvent(event)
  if (!evaluatePredicate(condition.predicate, { properties: afterProperties, fields })) {
    return null
  }

  if (isUpdateEvent(event)) {
    const beforeProperties = previousProperties(afterProperties, event.payload.propertyChanges)
    if (evaluatePredicate(condition.predicate, { properties: beforeProperties, fields })) {
      return null
    }
  }

  return {
    schedule,
    event: eventContext,
  }
}

export function buildEventScheduleContext(event: DomainEvent): RuntimeEventScheduleContext | null {
  switch (event.type) {
    case "object.created":
    case "object.updated":
    case "object.deleted":
      return {
        object: {
          objectTypeId: event.payload.objectTypeId,
          primaryId: event.payload.primaryId,
          p: currentProperties(event),
        },
      }
    case "link.created":
    case "link.updated":
    case "link.deleted":
      return {
        source: {
          objectTypeId: event.payload.sourceTypeId,
          primaryId: event.payload.sourceId,
        },
        target: {
          objectTypeId: event.payload.targetTypeId,
          primaryId: event.payload.targetId,
        },
        link: {
          id: event.payload.linkId,
          p: currentProperties(event),
        },
      }
    case "rule.triggered":
    case "rule.resolved":
      return {
        ruleId: event.payload.ruleId,
        subject: {
          objectTypeId: event.payload.subject.objectTypeId,
          primaryId: event.payload.subject.primaryId,
        },
      }
    case "action.requested":
      return {
        actionId: event.payload.actionId,
        runId: event.payload.runId,
        ...actionSubjectContext(event.payload.subject),
        params: { ...event.payload.params },
      }
    case "action.completed":
      return {
        actionId: event.payload.actionId,
        runId: event.payload.runId,
        ...actionSubjectContext(event.payload.subject),
      }
    case "action.failed":
      return {
        actionId: event.payload.actionId,
        runId: event.payload.runId,
        ...actionSubjectContext(event.payload.subject),
        error: event.payload.error,
      }
    case "dataset.version.committed":
      return { ...event.payload }
    case "sync.run.finished":
      return { ...event.payload }
    case "pipeline.run.finished":
      return { ...event.payload }
    default:
      return null
  }
}

function actionSubjectContext(subject: {
  readonly kind: "none" | "object"
  readonly objectTypeId?: string
  readonly primaryId?: string
}): { readonly subject?: { readonly objectTypeId: string; readonly primaryId: string } } {
  if (
    subject.kind !== "object" ||
    subject.objectTypeId === undefined ||
    subject.primaryId === undefined
  ) {
    return {}
  }

  return {
    subject: {
      objectTypeId: subject.objectTypeId,
      primaryId: subject.primaryId,
    },
  }
}

function fieldsForEvent(event: DomainEvent): Readonly<Record<string, unknown>> {
  if (event.topic !== "links") {
    return {}
  }

  return {
    "target.objectTypeId": event.payload.targetTypeId,
    "target.primaryId": event.payload.targetId,
  }
}

function propertiesForScope(
  event: DomainEvent,
  scope: EventScheduleConditionScope
): Readonly<Record<string, unknown>> {
  if (scope === "event.object" && event.topic !== "objects") {
    return {}
  }

  if (scope === "event.link" && event.topic !== "links") {
    return {}
  }

  return currentProperties(event)
}

function currentProperties(event: DomainEvent): Readonly<Record<string, unknown>> {
  const payload = event.payload
  if (payload && typeof payload === "object" && "properties" in payload) {
    return { ...((payload as { properties?: Record<string, unknown> }).properties ?? {}) }
  }

  if (payload && typeof payload === "object" && "propertyChanges" in payload) {
    return propertiesFromChanges(
      (payload as { propertyChanges: PropertyChangeMap }).propertyChanges,
      "after"
    )
  }

  return {}
}

function previousProperties(
  afterProperties: Readonly<Record<string, unknown>>,
  changes: PropertyChangeMap
): Readonly<Record<string, unknown>> {
  const before: Record<string, unknown> = { ...afterProperties }

  for (const [propertyId, change] of Object.entries(changes)) {
    if (change.operation === "created") {
      delete before[propertyId]
      continue
    }
    before[propertyId] = change.before
  }

  return before
}

function propertiesFromChanges(
  changes: PropertyChangeMap,
  side: "before" | "after"
): Readonly<Record<string, unknown>> {
  const properties: Record<string, unknown> = {}

  for (const [propertyId, change] of Object.entries(changes)) {
    const value = propertyChangeValue(change, side)
    if (value !== undefined) {
      properties[propertyId] = value
    }
  }

  return properties
}

function propertyChangeValue(change: PropertyChange, side: "before" | "after"): unknown {
  if (side === "before") {
    return change.operation === "created" ? undefined : change.before
  }
  return change.after
}

function isUpdateEvent(
  event: DomainEvent
): event is Extract<DomainEvent, { type: "object.updated" | "link.updated" }> {
  return event.type === "object.updated" || event.type === "link.updated"
}
