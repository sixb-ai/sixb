import type { RulePredicate } from "@sixb/core"
import type { EvaluateRulePredicateInput } from "./types"

type RulePropertyPredicate = Extract<RulePredicate, { kind: "property" }>
type RuleLinkPredicate = Extract<RulePredicate, { kind: "link" }>

/**
 * Evaluate a serializable rule predicate against one already-loaded object
 * subject and the subject's relevant outgoing links.
 */
export function evaluateRulePredicate(input: EvaluateRulePredicateInput): boolean {
  return evaluatePredicate(input.predicate, input)
}

function evaluatePredicate(predicate: RulePredicate, input: EvaluateRulePredicateInput): boolean {
  switch (predicate.kind) {
    case "all":
      return predicate.predicates.every((child) => evaluatePredicate(child, input))
    case "any":
      return predicate.predicates.some((child) => evaluatePredicate(child, input))
    case "not":
      return !evaluatePredicate(predicate.predicate, input)
    case "property":
      return evaluatePropertyPredicate(predicate, input.object.properties[predicate.propertyId])
    case "field":
      throw new Error("[SixbRulesWorker] Field predicates are not supported by rules.")
    case "link":
      return evaluateLinkPredicate(predicate, input.links.get(predicate.linkId) ?? [])
  }
}

function evaluatePropertyPredicate(predicate: RulePropertyPredicate, value: unknown): boolean {
  switch (predicate.op) {
    case "eq":
      return value === predicate.value
    case "notEq":
      return value !== predicate.value
    // Numeric comparisons intentionally do not coerce strings or other scalar
    // values. A malformed or non-numeric value simply does not satisfy the rule.
    case "gt":
      return isNumber(value) && isNumber(predicate.value) && value > predicate.value
    case "gte":
      return isNumber(value) && isNumber(predicate.value) && value >= predicate.value
    case "lt":
      return isNumber(value) && isNumber(predicate.value) && value < predicate.value
    case "lte":
      return isNumber(value) && isNumber(predicate.value) && value <= predicate.value
    case "isPresent":
      return value !== null && value !== undefined
    case "isMissing":
      return value === null || value === undefined
  }
}

/**
 * Link predicates only see the link ids the evaluator loaded for this rule.
 * A missing map entry therefore means "no outgoing links for this link id".
 */
function evaluateLinkPredicate(predicate: RuleLinkPredicate, links: readonly unknown[]): boolean {
  switch (predicate.op) {
    case "exists":
      return links.length > 0
    case "isMissing":
      return links.length === 0
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number"
}
