import { buildEventSelectorPredicate } from "../events/selectors"
import type { DomainEvent, PropertyChange, PropertyChangeMap } from "../events/types"
import { evaluatePredicate } from "../predicates"
import type { ActionRunFailure } from "../storage"
import type { TriggerConditionScope, TriggerDefinition } from "./types"

export type RuntimeTriggerEventContext =
  | {
      readonly object: {
        readonly objectTypeId: string
        readonly primaryId: string
        readonly p: Readonly<Record<string, unknown>>
      }
    }
  | {
      readonly source: { readonly objectTypeId: string; readonly primaryId: string }
      readonly target: { readonly objectTypeId: string; readonly primaryId: string }
      readonly link: {
        readonly id: string
        readonly p: Readonly<Record<string, unknown>>
      }
    }
  | {
      readonly ruleId: string
      readonly subject: { readonly objectTypeId: string; readonly primaryId: string }
    }
  | RuntimeActionTriggerEventContext

type RuntimeActionTriggerEventContext = {
  readonly actionId: string
  readonly runId: string
  readonly subject?: { readonly objectTypeId: string; readonly primaryId: string }
} & (
  | { readonly params: Readonly<Record<string, unknown>> }
  | { readonly error: ActionRunFailure }
  | Record<never, never>
)

export interface TriggerEvaluationResult {
  readonly trigger: TriggerDefinition
  readonly event: RuntimeTriggerEventContext
}

export function triggerSubscribedEventTypes(
  trigger: TriggerDefinition
): readonly DomainEvent["type"][] {
  return trigger.source.types ?? []
}

export function evaluateTrigger(
  trigger: TriggerDefinition,
  event: DomainEvent
): TriggerEvaluationResult | null {
  if (!buildEventSelectorPredicate(trigger.source)(event)) {
    return null
  }

  const eventContext = buildTriggerEventContext(event)
  if (!eventContext) {
    return null
  }

  if (!trigger.condition) {
    return { trigger, event: eventContext }
  }

  const afterProperties = propertiesForScope(event, trigger.condition.scope)
  const fields = fieldsForEvent(event)
  if (!evaluatePredicate(trigger.condition.predicate, { properties: afterProperties, fields })) {
    return null
  }

  if (isUpdateEvent(event)) {
    const beforeProperties = previousProperties(afterProperties, event.payload.propertyChanges)
    if (evaluatePredicate(trigger.condition.predicate, { properties: beforeProperties, fields })) {
      return null
    }
  }

  return { trigger, event: eventContext }
}

export function buildTriggerEventContext(event: DomainEvent): RuntimeTriggerEventContext | null {
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
  scope: TriggerConditionScope
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
