import type {
  EventSelectorSpec,
  InferEventSelectorContext,
  LinkEventSelectorContext,
  ObjectEventSelectorContext,
} from "../events/selectors"
import type {
  LinkToken,
  ObjectRef,
  ObjectTypeWithTokens,
  Property,
  PropertyToken,
} from "../ontology"
import type { InferPropertyValue } from "../ontology/inference"
import type { Predicate, PredicateValue, PropertyPredicate } from "../predicates"

/**
 * Declarative trigger that can request a sync or pipeline run.
 *
 * Multiple triggers on the same definition use OR semantics: any matching
 * trigger can request a run independently.
 *
 * The `status` field on `sync.finished` and `pipeline.finished` is currently
 * limited to `"succeeded"`. Future versions may extend this to `"failed"` or
 * `"any"` to support error-driven workflows.
 */
export type RunTrigger =
  | { readonly type: "schedule"; readonly scheduleId: string }
  | { readonly type: "sync.finished"; readonly syncId: string; readonly status: "succeeded" }
  | {
      readonly type: "pipeline.finished"
      readonly pipelineId: string
      readonly status: "succeeded"
    }
  | { readonly type: "dataset.updated"; readonly datasetId: string }

export interface TriggerDefinition<
  TId extends string = string,
  TSelector extends EventSelectorSpec = EventSelectorSpec,
> {
  /** Inert marker used by discovery and runtime registration. */
  readonly kind: "trigger"
  readonly id: TId
  /** Public event selector that defines which domain events this trigger can observe. */
  readonly source: EventSelectorSpec<InferEventSelectorContext<TSelector>>
  /**
   * V1 condition semantics are edge-triggered: the trigger fires when this
   * predicate becomes true after the observed mutation.
   */
  readonly condition?: TriggerCondition
}

export type TriggerConditionScope = "event.object" | "event.link"

export interface TriggerCondition {
  readonly kind: "becomesTrue"
  readonly scope: TriggerConditionScope
  readonly predicate: Predicate
}

export type TriggerScopedPredicate = TriggerCondition

export interface TriggerBuilder<TId extends string> {
  on<const TSelector extends EventSelectorSpec>(
    selector: TSelector
  ): TriggerWhereBuilder<TId, TSelector>
}

export type TriggerWhereBuilder<
  TId extends string,
  TSelector extends EventSelectorSpec,
> = TriggerDefinition<TId, TSelector> & {
  where(
    predicate: (
      event: TriggerPredicateContext<InferEventSelectorContext<TSelector>>
    ) => TriggerCondition
  ): TriggerDefinition<TId, TSelector>
}

export type TriggerPredicateContext<TContext> =
  TContext extends ObjectEventSelectorContext<infer TObjectType>
    ? {
        readonly object: TriggerObjectPredicateSubject<TObjectType>
      }
    : TContext extends LinkEventSelectorContext<infer TObjectType, infer TLink>
      ? {
          readonly link: TriggerLinkPredicateSubject<TObjectType, TLink>
        }
      : never

export type TriggerObjectPredicateSubject<TObjectType extends ObjectTypeWithTokens> =
  TriggerPredicateSubject<"event.object", TObjectType["p"]>

export type TriggerLinkPredicateSubject<
  _TObjectType extends ObjectTypeWithTokens,
  TLink extends LinkToken,
> = TriggerPredicateSubject<"event.link", LinkPropertyTokens<TLink>>

export type TriggerPredicateSubject<
  TScope extends TriggerConditionScope,
  TTokens extends Record<string, PropertyToken>,
> = {
  readonly p: {
    readonly [TPropertyId in keyof TTokens]: TTokens[TPropertyId] extends PropertyToken<
      string,
      string,
      infer TProperty
    >
      ? TriggerPropertyPredicateBuilder<TScope, TProperty>
      : never
  }
  all(...predicates: TriggerCondition[]): TriggerCondition
  any(...predicates: TriggerCondition[]): TriggerCondition
  not(predicate: TriggerCondition): TriggerCondition
}

export interface TriggerPropertyPredicateBuilder<
  TScope extends TriggerConditionScope = TriggerConditionScope,
  TProperty extends Property = Property,
> {
  eq(value: TriggerSerializableValue<TProperty>): TriggerConditionFor<TScope>
  notEq(value: TriggerSerializableValue<TProperty>): TriggerConditionFor<TScope>
  gt(value: TriggerNumericValue<TProperty>): TriggerConditionFor<TScope>
  gte(value: TriggerNumericValue<TProperty>): TriggerConditionFor<TScope>
  lt(value: TriggerNumericValue<TProperty>): TriggerConditionFor<TScope>
  lte(value: TriggerNumericValue<TProperty>): TriggerConditionFor<TScope>
  isPresent(): TriggerConditionFor<TScope>
  isMissing(): TriggerConditionFor<TScope>
}

export type TriggerConditionFor<TScope extends TriggerConditionScope> = TriggerCondition & {
  readonly scope: TScope
  readonly predicate: PropertyPredicate
}

export type TriggerSerializableValue<TProperty extends Property> = Extract<
  string extends TProperty["id"] ? PredicateValue : InferPropertyValue<TProperty>,
  PredicateValue
>

export type TriggerNumericValue<TProperty extends Property> = Extract<
  string extends TProperty["id"]
    ? number
    : TProperty["schema"] extends "integer" | "double" | "decimal"
      ? number
      : TProperty["schema"] extends { type: "enum"; valueType: "integer" }
        ? number
        : never,
  number
>

export type InferTriggerEvent<TTrigger extends TriggerDefinition> =
  TTrigger extends TriggerDefinition<string, infer TSelector>
    ? TriggerEventContext<InferEventSelectorContext<TSelector>>
    : never

export type TriggerEventContext<TContext> =
  TContext extends ObjectEventSelectorContext<infer TObjectType>
    ? TriggerObjectEventContext<TObjectType>
    : TContext extends LinkEventSelectorContext<infer TObjectType, infer TLink>
      ? TriggerLinkEventContext<TObjectType, TLink>
      : never

export interface TriggerObjectEventContext<TObjectType extends ObjectTypeWithTokens> {
  readonly object: {
    readonly objectTypeId: TObjectType["id"]
    readonly primaryId: string
    readonly p: TriggerObjectPropertyValues<TObjectType>
  }
}

export interface TriggerLinkEventContext<
  TObjectType extends ObjectTypeWithTokens,
  TLink extends LinkToken,
> {
  readonly source: ObjectRef<TObjectType["id"]>
  readonly target: ObjectRef<ResolveTargetTypeId<TLink["targetObjectTypeId"]>>
  readonly link: {
    readonly id: TLink["id"]
    readonly p: TriggerLinkPropertyValues<TLink>
  }
}

type LinkPropertyTokens<TLink extends LinkToken> =
  NonNullable<TLink["link"]["properties"]> extends readonly Property[]
    ? {
        readonly [P in NonNullable<TLink["link"]["properties"]>[number] as P["id"]]: PropertyToken<
          TLink["objectTypeId"],
          P["id"],
          P
        >
      }
    : Record<never, never>

type TriggerObjectPropertyValues<TObjectType extends ObjectTypeWithTokens> = {
  readonly [TProperty in TObjectType["properties"][number] as TProperty["id"]]: InferPropertyValue<TProperty>
}

type TriggerLinkPropertyValues<TLink extends LinkToken> =
  NonNullable<TLink["link"]["properties"]> extends readonly Property[]
    ? {
        readonly [TProperty in NonNullable<
          TLink["link"]["properties"]
        >[number] as TProperty["id"]]: InferPropertyValue<TProperty>
      }
    : Record<never, never>

type ResolveTargetTypeId<TTarget> = TTarget extends readonly string[]
  ? TTarget[number]
  : TTarget extends string
    ? TTarget
    : string

/** Runtime type guard for values discovered as triggers. */
export function isRunTrigger(value: unknown): value is RunTrigger {
  if (!isRecord(value)) return false

  switch (value.type) {
    case "schedule":
      return typeof value.scheduleId === "string"
    case "sync.finished":
      return typeof value.syncId === "string" && value.status === "succeeded"
    case "pipeline.finished":
      return typeof value.pipelineId === "string" && value.status === "succeeded"
    case "dataset.updated":
      return typeof value.datasetId === "string"
    default:
      return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
