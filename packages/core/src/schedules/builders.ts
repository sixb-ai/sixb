import { SixbError } from "../errors"
import type { EventSelectorSpec } from "../events/selectors"
import { eventSelectorSpec } from "../events/selectors"
import {
  allPredicates,
  anyPredicates,
  assertPredicateShape,
  createFieldPredicate,
  createPropertyPredicateBuilder,
  notPredicate,
  type Predicate,
  type RuntimePropertyPredicateBuilder,
} from "../predicates"
import { createCronMatcher } from "./cron"
import type {
  CronScheduleDefinition,
  EventScheduleCondition,
  EventScheduleConditionScope,
  EventScheduleDefinition,
  EventScheduleScopedPredicate,
  ScheduleBuilder,
} from "./types"

type RuntimeEventSchedulePropertyPredicateBuilder =
  RuntimePropertyPredicateBuilder<EventScheduleScopedPredicate>

type RuntimeEventSchedulePredicateSubject = {
  p: Record<string, RuntimeEventSchedulePropertyPredicateBuilder>
  all(...predicates: EventScheduleCondition[]): EventScheduleCondition
  any(...predicates: EventScheduleCondition[]): EventScheduleCondition
  not(predicate: EventScheduleCondition): EventScheduleCondition
}

type RuntimeEventSchedulePredicateContext = {
  object?: RuntimeEventSchedulePredicateSubject
  link?: RuntimeEventSchedulePredicateSubject
  target?: RuntimeEventScheduleTargetPredicateSubject
}

type RuntimeEventScheduleTargetPredicateSubject = {
  is(objectType: { readonly id: string }): EventScheduleCondition
  id: { eq(value: string): EventScheduleCondition }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new SixbError("runtime.invalid_definition", `Schedule ${field} must not be empty.`)
  }
}

function validateTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
  } catch {
    throw new SixbError("runtime.invalid_definition", `Invalid timezone '${timezone}'.`)
  }
}

function createCondition(
  scope: EventScheduleConditionScope,
  predicate: Predicate
): EventScheduleCondition {
  return {
    kind: "becomesTrue",
    scope,
    predicate,
  }
}

function createEventSchedulePropertyPredicateBuilder(
  scope: EventScheduleConditionScope,
  propertyId: string
): RuntimeEventSchedulePropertyPredicateBuilder {
  return createPropertyPredicateBuilder(propertyId, {
    subject: "Schedule",
    createError: (message) => new SixbError("runtime.invalid_definition", message),
    wrap: (predicate) => createCondition(scope, predicate),
  })
}

function createPredicateSubject(
  scope: EventScheduleConditionScope
): RuntimeEventSchedulePredicateSubject {
  const properties = new Proxy<Record<string, RuntimeEventSchedulePropertyPredicateBuilder>>(
    {},
    {
      get(target, property) {
        if (typeof property !== "string") return undefined
        target[property] ??= createEventSchedulePropertyPredicateBuilder(scope, property)
        return target[property]
      },
    }
  )

  return {
    p: properties,
    all(...conditions) {
      return createCondition(
        scope,
        allPredicates(conditions.map((condition) => condition.predicate))
      )
    },
    any(...conditions) {
      return createCondition(
        scope,
        anyPredicates(conditions.map((condition) => condition.predicate))
      )
    },
    not(condition) {
      return createCondition(scope, notPredicate(condition.predicate))
    },
  }
}

function createTargetPredicateSubject(): RuntimeEventScheduleTargetPredicateSubject {
  const condition = (field: string, value: string) =>
    createCondition(
      "event.link",
      createFieldPredicate(field, value, {
        subject: "Schedule",
        createError: (message) => new SixbError("runtime.invalid_definition", message),
      })
    )

  return {
    is(objectType) {
      assertNonEmpty(objectType.id, "target object type id")
      return condition("target.objectTypeId", objectType.id)
    },
    id: {
      eq(value) {
        assertNonEmpty(value, "target object id")
        return condition("target.primaryId", value)
      },
    },
  }
}

function createPredicateContext(selector: EventSelectorSpec): RuntimeEventSchedulePredicateContext {
  if (selector.topic === "objects") {
    return { object: createPredicateSubject("event.object") }
  }

  if (selector.topic === "links") {
    return {
      link: createPredicateSubject("event.link"),
      target: createTargetPredicateSubject(),
    }
  }

  return {}
}

function assertEventSource(source: EventSelectorSpec): void {
  if (!source.types || source.types.length === 0) {
    throw new SixbError(
      "runtime.invalid_definition",
      "Schedule event source must select an event operation, e.g. .created(), .updated(), or .succeeded()."
    )
  }

  switch (source.topic) {
    case "objects":
      assertNonEmpty(source.objectTypeId ?? "", "event source objectTypeId")
      return
    case "links":
      assertNonEmpty(source.objectTypeId ?? "", "event source objectTypeId")
      assertNonEmpty(source.linkId ?? "", "event source linkId")
      return
    case "rules":
      assertNonEmpty(source.ruleId ?? "", "event source ruleId")
      return
    case "actions":
      assertNonEmpty(source.actionId ?? "", "event source actionId")
      return
    case "datasets":
      assertNonEmpty(source.datasetId ?? "", "event source datasetId")
      return
    case "syncs":
      assertNonEmpty(source.syncId ?? "", "event source syncId")
      return
    case "pipelines":
      assertNonEmpty(source.pipelineId ?? "", "event source pipelineId")
      return
    default:
      throw new SixbError(
        "runtime.invalid_definition",
        "Schedule event source must select object, link, rule, action, dataset, sync, or pipeline events."
      )
  }
}

/** Define an inert, reusable policy describing when work should run. */
export function defineSchedule<const TId extends string>(id: TId): ScheduleBuilder<TId>
export function defineSchedule(id: string): ScheduleBuilder<string> {
  assertNonEmpty(id, "id")

  return {
    cron(expression, options): CronScheduleDefinition {
      assertNonEmpty(expression, "cron expression")
      createCronMatcher(expression)

      if (options?.timezone !== undefined) validateTimezone(options.timezone)

      return {
        kind: "schedule",
        id,
        trigger: {
          type: "cron",
          expression,
          ...(options?.timezone !== undefined ? { timezone: options.timezone } : {}),
        },
      }
    },
    on(selector: EventSelectorSpec): unknown {
      const source = eventSelectorSpec(selector)
      assertEventSource(source)

      const base = {
        kind: "schedule" as const,
        id,
        trigger: {
          type: "event" as const,
          source,
        },
      }

      if (source.topic !== "objects" && source.topic !== "links") {
        return base satisfies EventScheduleDefinition
      }

      Object.defineProperty(base, "where", {
        enumerable: false,
        value(callback: (event: RuntimeEventSchedulePredicateContext) => EventScheduleCondition) {
          const condition = callback(createPredicateContext(source))
          if (!condition || condition.kind !== "becomesTrue") {
            throw new SixbError(
              "runtime.invalid_definition",
              "Schedule condition must be built from the event DSL."
            )
          }
          assertPredicateShape(condition.predicate, {
            subject: "Schedule",
            createError: (message) => new SixbError("runtime.invalid_definition", message),
          })

          return {
            ...base,
            trigger: {
              ...base.trigger,
              condition,
            },
          } satisfies EventScheduleDefinition
        },
      })

      return base
    },
  } as ScheduleBuilder<string>
}
