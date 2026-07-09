import type { ObjectLink, ObjectType, Property } from "../ontology/types"
import type {
  AllPredicate,
  AnyPredicate,
  LinkPredicate,
  LinkPredicateBuilder,
  LinkPredicateOperator,
  NotPredicate,
  Predicate,
  PredicateValue,
  PropertyPredicate,
  PropertyPredicateBuilder,
  PropertyPredicateOperator,
} from "../predicates"

export interface RuleDefinition<
  TId extends string = string,
  TObjectType extends RuleObjectType = RuleObjectType,
> {
  /** Inert marker used by discovery and runtime registration. */
  readonly kind: "rule"
  readonly id: TId
  /** The ontology entity kind this rule evaluates against. V1 supports objects only. */
  readonly subject: RuleSubject<TObjectType["id"]>
  /** Serializable predicate AST. No executable callbacks are retained after `.where(...)`. */
  readonly predicate: RulePredicate
}

export type RuleSubject<TObjectTypeId extends string = string> = {
  readonly kind: "object"
  readonly objectTypeId: TObjectTypeId
}

export type RulePredicate = Predicate
export type RuleAllPredicate = AllPredicate
export type RuleAnyPredicate = AnyPredicate
export type RuleNotPredicate = NotPredicate
export type RulePropertyOperator = PropertyPredicateOperator
export type RulePropertyPredicate = PropertyPredicate
export type RuleLinkOperator = LinkPredicateOperator
export type RuleLinkPredicate = LinkPredicate
export type RuleValue = PredicateValue

/**
 * Minimal event filters a future rule runtime can use before evaluation.
 *
 * The events runtime filters by event type only today, so payload-level filtering is
 * intentionally represented as data here rather than encoded in subscriptions.
 */
export type RuleEventDependency =
  | {
      readonly type: "object.created" | "object.updated" | "object.deleted"
      readonly objectTypeId: string
    }
  | {
      readonly type: "link.created" | "link.updated" | "link.deleted"
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

export type RulePropertyPredicateBuilder<_TProperty extends Property = Property> =
  PropertyPredicateBuilder<_TProperty>

export type RuleLinkPredicateBuilder<_TLink extends ObjectLink = ObjectLink> =
  LinkPredicateBuilder<_TLink>

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
  where(
    predicate: (subject: RuleSubjectBuilder<TObjectType>) => RulePredicate
  ): RuleDefinition<TId, TObjectType>
}

export interface RuleBuilder<TId extends string> {
  on<const TObjectType extends RuleObjectType>(
    objectType: TObjectType
  ): RuleWhereBuilder<TId, TObjectType>
}
