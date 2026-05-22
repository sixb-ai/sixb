import { RuleValidationError } from "./errors"
import type {
  RuleBuilder,
  RuleDefinition,
  RuleLinkPredicateBuilder,
  RuleObjectType,
  RulePredicate,
  RulePropertyOperator,
  RulePropertyPredicate,
  RuleValue,
} from "./types"
import { assertRulePredicateShape, isRuleValue } from "./validation"

/**
 * Runtime builders stay deliberately concrete.
 *
 * The public overload below provides typed property/link keys to callers, while
 * this internal shape keeps the implementation simple and avoids asking
 * TypeScript to instantiate the full ontology mapped type while checking this
 * file.
 */
type RuntimeRulePropertyPredicateBuilder = {
  eq(value: RuleValue): RulePropertyPredicate
  notEq(value: RuleValue): RulePropertyPredicate
  gt(value: RuleValue): RulePropertyPredicate
  gte(value: RuleValue): RulePropertyPredicate
  lt(value: RuleValue): RulePropertyPredicate
  lte(value: RuleValue): RulePropertyPredicate
  isPresent(): RulePropertyPredicate
  isMissing(): RulePropertyPredicate
}

type RuntimeRuleSubjectBuilder = {
  p: Record<string, RuntimeRulePropertyPredicateBuilder>
  l: Record<string, RuleLinkPredicateBuilder>
  all(...predicates: RulePredicate[]): RulePredicate
  any(...predicates: RulePredicate[]): RulePredicate
  not(predicate: RulePredicate): RulePredicate
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new RuleValidationError(`Rule ${field} must not be empty.`)
  }
}

function assertSerializableRuleValue(value: RuleValue): void {
  if (!isRuleValue(value)) {
    throw new RuleValidationError("Rule predicate values must be serializable scalar values.")
  }
}

/** Lower a single property method call into its serializable AST node. */
function createPropertyPredicate(
  propertyId: string,
  op: RulePropertyOperator,
  value: RuleValue
): RulePropertyPredicate {
  assertSerializableRuleValue(value)
  return {
    kind: "property",
    propertyId,
    op,
    value,
  }
}

/** Build the `tx.p.<propertyId>` API for one ontology property. */
function createPropertyPredicateBuilder(propertyId: string): RuntimeRulePropertyPredicateBuilder {
  return {
    eq(value) {
      return createPropertyPredicate(propertyId, "eq", value)
    },
    notEq(value) {
      return createPropertyPredicate(propertyId, "notEq", value)
    },
    gt(value) {
      return createPropertyPredicate(propertyId, "gt", value)
    },
    gte(value) {
      return createPropertyPredicate(propertyId, "gte", value)
    },
    lt(value) {
      return createPropertyPredicate(propertyId, "lt", value)
    },
    lte(value) {
      return createPropertyPredicate(propertyId, "lte", value)
    },
    isPresent() {
      return {
        kind: "property",
        propertyId,
        op: "isPresent",
      }
    },
    isMissing() {
      return {
        kind: "property",
        propertyId,
        op: "isMissing",
      }
    },
  }
}

/** Build the `tx.l.<linkId>` API for one ontology link. */
function createLinkPredicateBuilder(linkId: string): RuleLinkPredicateBuilder {
  return {
    exists() {
      return {
        kind: "link",
        linkId,
        op: "exists",
      }
    },
    isMissing() {
      return {
        kind: "link",
        linkId,
        op: "isMissing",
      }
    },
  }
}

/**
 * Build the callback subject from ontology metadata.
 *
 * This object is only used while `.where(...)` executes. The returned
 * RuleDefinition stores the predicate data produced by these methods, not this
 * builder object or the user callback.
 */
function createRuleSubjectBuilder<TObjectType extends RuleObjectType>(
  objectType: TObjectType
): RuntimeRuleSubjectBuilder {
  const properties = Object.fromEntries(
    objectType.properties.map((property) => [
      property.id,
      createPropertyPredicateBuilder(property.id),
    ])
  )

  const links = Object.fromEntries(
    objectType.links.map((link) => [link.id, createLinkPredicateBuilder(link.id)])
  )

  return {
    p: properties,
    l: links,
    all(...predicates: RulePredicate[]): RulePredicate {
      return {
        kind: "all",
        predicates: [...predicates],
      }
    },
    any(...predicates: RulePredicate[]): RulePredicate {
      return {
        kind: "any",
        predicates: [...predicates],
      }
    },
    not(predicate: RulePredicate): RulePredicate {
      return {
        kind: "not",
        predicate,
      }
    },
  }
}

/**
 * Define an inert business rule.
 *
 * The overload preserves literal ids and typed property/link keys for users.
 * The implementation returns a concrete builder and casts at the boundary so
 * runtime code stays small while callers still get the typed DSL.
 */
export function defineRule<const TId extends string>(id: TId): RuleBuilder<TId>
export function defineRule(id: string): RuleBuilder<string> {
  assertNonEmpty(id, "id")

  const builder = {
    on(objectType: RuleObjectType) {
      return {
        where(callback: (subject: RuntimeRuleSubjectBuilder) => RulePredicate): RuleDefinition {
          const predicate = callback(createRuleSubjectBuilder(objectType))
          assertRulePredicateShape(predicate)

          return {
            kind: "rule",
            id,
            subject: {
              kind: "object",
              objectTypeId: objectType.id,
            },
            predicate,
          }
        },
      }
    },
  }

  return builder as unknown as RuleBuilder<string>
}
