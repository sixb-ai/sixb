import type {
  EventSelectorSpec,
  InferEventSelectorContext,
  InferEventSelectorEvent,
  LinkEventSelectorContext,
  ObjectEventSelectorContext,
} from "../events/selectors"
import type { LinkToken, ObjectTypeWithTokens, Property, PropertyToken } from "../ontology"
import type {
  FieldPredicate,
  OrderedPredicateValueFor,
  Predicate,
  PredicateValueFor,
  PropertyPredicate,
  PropertyPredicateBuilder,
} from "../predicates"

declare const scheduleEventType: unique symbol

export interface CronScheduleTriggerDefinition {
  readonly type: "cron"
  readonly expression: string
  readonly timezone?: string
}

export interface EventScheduleTriggerDefinition<
  TSelector extends EventSelectorSpec<unknown> = EventSelectorSpec,
> {
  readonly type: "event"
  readonly source: TSelector
  readonly condition?: EventScheduleCondition
}

export type ScheduleTriggerDefinition =
  | CronScheduleTriggerDefinition
  | EventScheduleTriggerDefinition

/** Internal reference stored by definitions that run from a named schedule. */
export interface ScheduleReference {
  readonly type: "schedule"
  readonly scheduleId: string
}

export function isScheduleReference(value: unknown): value is ScheduleReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "schedule" &&
    "scheduleId" in value &&
    typeof value.scheduleId === "string" &&
    value.scheduleId.trim().length > 0
  )
}

/** Inert, reusable definition of when work should run. */
export interface ScheduleDefinition<TId extends string = string, TEvent = unknown> {
  readonly [scheduleEventType]?: TEvent
  readonly kind: "schedule"
  readonly id: TId
  readonly trigger: ScheduleTriggerDefinition
}

export type CronScheduleDefinition<TId extends string = string> = ScheduleDefinition<TId, never> & {
  readonly trigger: CronScheduleTriggerDefinition
}

export type EventScheduleDefinition<
  TId extends string = string,
  TSelector extends EventSelectorSpec<unknown> = EventSelectorSpec,
> = ScheduleDefinition<TId, InferEventSelectorEvent<TSelector>> & {
  readonly trigger: EventScheduleTriggerDefinition<TSelector>
}

export type ScheduleDefinitionForEvent<TEvent = unknown> = ScheduleDefinition<string, TEvent> & {
  readonly trigger: EventScheduleTriggerDefinition
}

export type InferScheduleEvent<TSchedule> = TSchedule extends {
  readonly [scheduleEventType]?: infer TEvent
}
  ? NonNullable<TEvent>
  : never

export interface CronScheduleBuilder<TId extends string = string> {
  cron(expression: string, options?: { timezone?: string }): CronScheduleDefinition<TId>
}

export interface EventScheduleBuilder<TId extends string = string> {
  on<const TSelector extends EventSelectorSpec<unknown>>(
    selector: TSelector
  ): EventScheduleSourceBuilder<TId, TSelector>
}

export interface ScheduleBuilder<TId extends string = string>
  extends CronScheduleBuilder<TId>,
    EventScheduleBuilder<TId> {}

export type EventScheduleSourceBuilder<
  TId extends string,
  TSelector extends EventSelectorSpec<unknown>,
> =
  InferEventSelectorContext<TSelector> extends ObjectEventSelectorContext | LinkEventSelectorContext
    ? EventScheduleWhereBuilder<TId, TSelector>
    : EventScheduleDefinition<TId, TSelector>

export type EventScheduleWhereBuilder<
  TId extends string,
  TSelector extends EventSelectorSpec<unknown>,
> = EventScheduleDefinition<TId, TSelector> & {
  where(
    predicate: (
      event: EventSchedulePredicateContext<InferEventSelectorContext<TSelector>>
    ) => EventScheduleCondition
  ): EventScheduleDefinition<TId, TSelector>
}

export type EventScheduleConditionScope = "event.object" | "event.link"

export interface EventScheduleCondition {
  readonly kind: "becomesTrue"
  readonly scope: EventScheduleConditionScope
  readonly predicate: Predicate
}

export type EventScheduleScopedPredicate = EventScheduleCondition

export type EventSchedulePredicateContext<TContext> =
  TContext extends ObjectEventSelectorContext<infer TObjectType>
    ? { readonly object: EventScheduleObjectPredicateSubject<TObjectType> }
    : TContext extends LinkEventSelectorContext<infer TObjectType, infer TLink>
      ? {
          readonly link: EventScheduleLinkPredicateSubject<TObjectType, TLink>
          readonly target: EventScheduleTargetPredicateSubject<TLink>
        }
      : never

export type EventScheduleObjectPredicateSubject<TObjectType extends ObjectTypeWithTokens> =
  EventSchedulePredicateSubject<"event.object", TObjectType["p"]>

export type EventScheduleLinkPredicateSubject<
  _TObjectType extends ObjectTypeWithTokens,
  TLink extends LinkToken,
> = EventSchedulePredicateSubject<"event.link", LinkPropertyTokens<TLink>>

export type EventScheduleTargetPredicateSubject<TLink extends LinkToken> = {
  is(
    objectType: ObjectTypeWithTokens & { readonly id: AllowedTargetTypeId<TLink> }
  ): EventScheduleConditionFor<"event.link", FieldPredicate>
  readonly id: {
    eq(value: string): EventScheduleConditionFor<"event.link", FieldPredicate>
  }
}

export type EventSchedulePredicateSubject<
  TScope extends EventScheduleConditionScope,
  TTokens extends Record<string, PropertyToken>,
> = {
  readonly p: {
    readonly [TPropertyId in keyof TTokens]: TTokens[TPropertyId] extends PropertyToken<
      string,
      string,
      infer TProperty
    >
      ? EventSchedulePropertyPredicateBuilder<TScope, TProperty>
      : never
  }
  all(...predicates: EventScheduleCondition[]): EventScheduleCondition
  any(...predicates: EventScheduleCondition[]): EventScheduleCondition
  not(predicate: EventScheduleCondition): EventScheduleCondition
}

export type EventSchedulePropertyPredicateBuilder<
  TScope extends EventScheduleConditionScope = EventScheduleConditionScope,
  TProperty extends Property = Property,
> = PropertyPredicateBuilder<TProperty, EventScheduleConditionFor<TScope>>

export type EventScheduleConditionFor<
  TScope extends EventScheduleConditionScope,
  TPredicate extends Predicate = PropertyPredicate,
> = EventScheduleCondition & {
  readonly scope: TScope
  readonly predicate: TPredicate
}

export type EventScheduleSerializableValue<TProperty extends Property> =
  PredicateValueFor<TProperty>

export type EventScheduleNumericValue<TProperty extends Property> =
  OrderedPredicateValueFor<TProperty>

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

type ResolveTargetTypeId<TTarget> = TTarget extends readonly string[]
  ? TTarget[number]
  : TTarget extends string
    ? TTarget
    : string

type AllowedTargetTypeId<TLink extends LinkToken> =
  "*" extends ResolveTargetTypeId<TLink["targetObjectTypeId"]>
    ? string
    : ResolveTargetTypeId<TLink["targetObjectTypeId"]>
