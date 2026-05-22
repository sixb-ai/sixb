import type { ObjectLink, ObjectType, Property } from "../ontology/types"

export interface RuleDefinition<TId extends string = string> {
  /** Inert marker used by discovery and runtime registration. */
  readonly kind: "rule"
  readonly id: TId
  /** The ontology entity kind this rule evaluates against. V1 supports objects only. */
  readonly subject: RuleSubject
  /** Serializable predicate AST. No executable callbacks are retained after `.where(...)`. */
  readonly predicate: RulePredicate
}

export type RuleSubject = {
  readonly kind: "object"
  readonly objectTypeId: string
}

export type RulePredicate =
  | RuleAllPredicate
  | RuleAnyPredicate
  | RuleNotPredicate
  | RulePropertyPredicate
  | RuleLinkPredicate

export interface RuleAllPredicate {
  readonly kind: "all"
  readonly predicates: readonly RulePredicate[]
}

export interface RuleAnyPredicate {
  readonly kind: "any"
  readonly predicates: readonly RulePredicate[]
}

export interface RuleNotPredicate {
  readonly kind: "not"
  readonly predicate: RulePredicate
}

export type RulePropertyOperator =
  | "eq"
  | "notEq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isPresent"
  | "isMissing"

export interface RulePropertyPredicate {
  readonly kind: "property"
  readonly propertyId: string
  readonly op: RulePropertyOperator
  readonly value?: RuleValue
}

export type RuleLinkOperator = "exists" | "isMissing"

export interface RuleLinkPredicate {
  readonly kind: "link"
  readonly linkId: string
  readonly op: RuleLinkOperator
}

export type RuleValue = string | number | boolean | null

/**
 * Minimal event filters a future rule runtime can use before evaluation.
 *
 * The events runtime filters by event type only today, so payload-level filtering is
 * intentionally represented as data here rather than encoded in subscriptions.
 */
export type RuleEventDependency =
  | {
      readonly type: "object.upserted"
      readonly objectTypeId: string
    }
  | {
      readonly type: "link.upserted" | "link.removed"
      readonly sourceTypeId: string
      readonly linkId: string
    }

export type RuleObjectType = Pick<ObjectType, "id" | "properties" | "links">

type PropertyIdOf<TObjectType extends RuleObjectType> = TObjectType["properties"][number]["id"]

type PropertyById<
  TObjectType extends RuleObjectType,
  TPropertyId extends PropertyIdOf<TObjectType>,
> = Extract<TObjectType["properties"][number], { id: TPropertyId }>

type LinkIdOf<TObjectType extends RuleObjectType> = TObjectType["links"][number]["id"]

type LinkById<TObjectType extends RuleObjectType, TLinkId extends LinkIdOf<TObjectType>> = Extract<
  TObjectType["links"][number],
  { id: TLinkId }
>

export interface RulePropertyPredicateBuilder<_TProperty extends Property = Property> {
  eq(value: RuleValue): RulePropertyPredicate
  notEq(value: RuleValue): RulePropertyPredicate
  gt(value: number): RulePropertyPredicate
  gte(value: number): RulePropertyPredicate
  lt(value: number): RulePropertyPredicate
  lte(value: number): RulePropertyPredicate
  isPresent(): RulePropertyPredicate
  isMissing(): RulePropertyPredicate
}

export interface RuleLinkPredicateBuilder<_TLink extends ObjectLink = ObjectLink> {
  exists(): RuleLinkPredicate
  isMissing(): RuleLinkPredicate
}

export type RuleSubjectBuilder<TObjectType extends RuleObjectType> = {
  /** Property predicates keyed by the selected object type's property ids. */
  readonly p: {
    readonly [TPropertyId in PropertyIdOf<TObjectType>]: RulePropertyPredicateBuilder<
      PropertyById<TObjectType, TPropertyId>
    >
  }
  /** Link predicates keyed by the selected object type's link ids. */
  readonly l: {
    readonly [TLinkId in LinkIdOf<TObjectType>]: RuleLinkPredicateBuilder<
      LinkById<TObjectType, TLinkId>
    >
  }
  /** Logical AND group. Empty groups are rejected during startup validation. */
  all(...predicates: RulePredicate[]): RulePredicate
  /** Logical OR group. Empty groups are rejected during startup validation. */
  any(...predicates: RulePredicate[]): RulePredicate
  not(predicate: RulePredicate): RulePredicate
}

export interface RuleWhereBuilder<TId extends string, TObjectType extends RuleObjectType> {
  where(predicate: (subject: RuleSubjectBuilder<TObjectType>) => RulePredicate): RuleDefinition<TId>
}

export interface RuleBuilder<TId extends string> {
  on<const TObjectType extends RuleObjectType>(
    objectType: TObjectType
  ): RuleWhereBuilder<TId, TObjectType>
}
