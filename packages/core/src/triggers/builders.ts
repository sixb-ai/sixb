import type { EventSelectorSpec } from "../events/selectors"
import { eventSelectorSpec } from "../events/selectors"
import {
  allPredicates,
  anyPredicates,
  assertPredicateShape,
  createPropertyPredicateBuilder,
  notPredicate,
  type Predicate,
  type RuntimePropertyPredicateBuilder,
} from "../predicates"
import { TriggerValidationError } from "./errors"
import type {
  RunTrigger,
  TriggerBuilder,
  TriggerCondition,
  TriggerConditionScope,
  TriggerDefinition,
  TriggerScopedPredicate,
} from "./types"

type RuntimeTriggerPropertyPredicateBuilder =
  RuntimePropertyPredicateBuilder<TriggerScopedPredicate>

type RuntimeTriggerPredicateSubject = {
  p: Record<string, RuntimeTriggerPropertyPredicateBuilder>
  all(...predicates: TriggerCondition[]): TriggerCondition
  any(...predicates: TriggerCondition[]): TriggerCondition
  not(predicate: TriggerCondition): TriggerCondition
}

type RuntimeTriggerPredicateContext = {
  object?: RuntimeTriggerPredicateSubject
  link?: RuntimeTriggerPredicateSubject
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new TriggerValidationError(`Trigger ${field} must not be empty.`)
  }
}

function createCondition(scope: TriggerConditionScope, predicate: Predicate): TriggerCondition {
  return {
    kind: "becomesTrue",
    scope,
    predicate,
  }
}

function createTriggerPropertyPredicateBuilder(
  scope: TriggerConditionScope,
  propertyId: string
): RuntimeTriggerPropertyPredicateBuilder {
  return createPropertyPredicateBuilder(propertyId, {
    subject: "Trigger",
    createError: (message) => new TriggerValidationError(message),
    wrap: (predicate) => createCondition(scope, predicate),
  })
}

function createPredicateSubject(scope: TriggerConditionScope): RuntimeTriggerPredicateSubject {
  const properties = new Proxy<Record<string, RuntimeTriggerPropertyPredicateBuilder>>(
    {},
    {
      get(target, property) {
        if (typeof property !== "string") {
          return undefined
        }
        target[property] ??= createTriggerPropertyPredicateBuilder(scope, property)
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

function createPredicateContext(selector: EventSelectorSpec): RuntimeTriggerPredicateContext {
  if (selector.topic === "objects") {
    return {
      object: createPredicateSubject("event.object"),
    }
  }

  if (selector.topic === "links") {
    return {
      link: createPredicateSubject("event.link"),
    }
  }

  return {}
}

function assertTriggerSource(source: EventSelectorSpec): void {
  if (source.objectTypeId?.trim() && (!source.types || source.types.length === 0)) {
    throw new TriggerValidationError(
      "Trigger source must select an event operation, e.g. .created(), .updated(), or .deleted()."
    )
  }

  if (source.topic !== "objects" && source.topic !== "links") {
    throw new TriggerValidationError(
      "Trigger source must be an object or link event selector, e.g. events(Invoice).updated()."
    )
  }

  if (!source.objectTypeId?.trim()) {
    throw new TriggerValidationError("Trigger source objectTypeId must not be empty.")
  }

  if (source.topic === "links" && !source.linkId?.trim()) {
    throw new TriggerValidationError("Trigger link source linkId must not be empty.")
  }
}

/** Define an inert domain trigger from a public event selector. */
export function defineTrigger<const TId extends string>(id: TId): TriggerBuilder<TId>
export function defineTrigger(id: string): TriggerBuilder<string> {
  assertNonEmpty(id, "id")

  return {
    on(selector: EventSelectorSpec): unknown {
      const source = eventSelectorSpec(selector)
      assertTriggerSource(source)

      const base = {
        kind: "trigger" as const,
        id,
        source,
      }

      Object.defineProperty(base, "where", {
        enumerable: false,
        value(callback: (event: RuntimeTriggerPredicateContext) => TriggerCondition) {
          const condition = callback(createPredicateContext(source))
          if (!condition || condition.kind !== "becomesTrue") {
            throw new TriggerValidationError("Trigger condition must be built from the event DSL.")
          }
          assertPredicateShape(condition.predicate, {
            subject: "Trigger",
            createError: (message) => new TriggerValidationError(message),
          })

          return {
            ...base,
            condition,
          } satisfies TriggerDefinition
        },
      })

      return base
    },
  } as unknown as TriggerBuilder<string>
}

/** Trigger that fires when a named sync run succeeds. */
export function syncFinished(syncId: string): RunTrigger {
  assertNonEmpty(syncId, "syncId")
  return { type: "sync.finished", syncId, status: "succeeded" }
}

/** Trigger that fires when a named pipeline run succeeds. */
export function pipelineFinished(pipelineId: string): RunTrigger {
  assertNonEmpty(pipelineId, "pipelineId")
  return { type: "pipeline.finished", pipelineId, status: "succeeded" }
}

/** Trigger that fires when a named dataset receives a new committed version. */
export function datasetUpdated(datasetId: string): RunTrigger {
  assertNonEmpty(datasetId, "datasetId")
  return { type: "dataset.updated", datasetId }
}
