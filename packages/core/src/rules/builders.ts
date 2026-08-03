import { SixbError } from "../errors"
import {
  allPredicates,
  anyPredicates,
  createLinkPredicateBuilder as createSharedLinkPredicateBuilder,
  createPropertyPredicateBuilder as createSharedPropertyPredicateBuilder,
  notPredicate,
  type RuntimePropertyPredicateBuilder,
} from "../predicates"
import type {
  RuleBuilder,
  RuleDefinition,
  RuleLinkPredicateBuilder,
  RuleObjectType,
  RulePredicate,
  RulePropertyPredicate,
} from "./types"
import { assertRulePredicateShape } from "./validation"

/**
 * Runtime builders stay deliberately concrete.
 *
 * The public overload below provides typed property/link keys to callers, while
 * this internal shape keeps the implementation simple and avoids asking
 * TypeScript to instantiate the full ontology mapped type while checking this
 * file.
 */
type RuntimeRulePropertyPredicateBuilder = RuntimePropertyPredicateBuilder<RulePropertyPredicate>

type RuntimeRuleSubjectBuilder = {
  p: Record<string, RuntimeRulePropertyPredicateBuilder>
  l: Record<string, RuleLinkPredicateBuilder>
  all(...predicates: RulePredicate[]): RulePredicate
  any(...predicates: RulePredicate[]): RulePredicate
  not(predicate: RulePredicate): RulePredicate
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new SixbError("runtime.invalid_definition", `Rule ${field} must not be empty.`)
  }
}

/** Build the `tx.p.<propertyId>` API for one ontology property. */
function createPropertyPredicateBuilder(propertyId: string): RuntimeRulePropertyPredicateBuilder {
  return createSharedPropertyPredicateBuilder(propertyId, {
    subject: "Rule",
    createError: (message) => new SixbError("runtime.invalid_definition", message),
  })
}

/** Build the `tx.l.<linkId>` API for one ontology link. */
function createLinkPredicateBuilder(linkId: string): RuleLinkPredicateBuilder {
  return createSharedLinkPredicateBuilder(linkId)
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
      return allPredicates(predicates)
    },
    any(...predicates: RulePredicate[]): RulePredicate {
      return anyPredicates(predicates)
    },
    not(predicate: RulePredicate): RulePredicate {
      return notPredicate(predicate)
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
