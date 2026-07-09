import type { LinkPredicate, Predicate, PredicateValue, PropertyPredicate } from "./types"

export interface PredicateEvaluationSubject {
  readonly properties?: Readonly<Record<string, unknown>>
  readonly links?: Readonly<Record<string, boolean>>
}

export function evaluatePredicate(
  predicate: Predicate,
  subject: PredicateEvaluationSubject
): boolean {
  switch (predicate.kind) {
    case "all":
      return predicate.predicates.every((child) => evaluatePredicate(child, subject))
    case "any":
      return predicate.predicates.some((child) => evaluatePredicate(child, subject))
    case "not":
      return !evaluatePredicate(predicate.predicate, subject)
    case "property":
      return evaluatePropertyPredicate(predicate, subject.properties ?? {})
    case "link":
      return evaluateLinkPredicate(predicate, subject.links ?? {})
  }
}

function evaluatePropertyPredicate(
  predicate: PropertyPredicate,
  properties: Readonly<Record<string, unknown>>
): boolean {
  const value = properties[predicate.propertyId]
  const isPresent = value !== undefined && value !== null

  switch (predicate.op) {
    case "eq":
      return isPresent && predicateValueEquals(value, predicate.value)
    case "notEq":
      return !isPresent || !predicateValueEquals(value, predicate.value)
    case "gt":
      return isNumber(value) && isNumber(predicate.value) && value > predicate.value
    case "gte":
      return isNumber(value) && isNumber(predicate.value) && value >= predicate.value
    case "lt":
      return isNumber(value) && isNumber(predicate.value) && value < predicate.value
    case "lte":
      return isNumber(value) && isNumber(predicate.value) && value <= predicate.value
    case "isPresent":
      return isPresent
    case "isMissing":
      return !isPresent
  }
}

function evaluateLinkPredicate(
  predicate: LinkPredicate,
  links: Readonly<Record<string, boolean>>
): boolean {
  const exists = links[predicate.linkId] === true
  switch (predicate.op) {
    case "exists":
      return exists
    case "isMissing":
      return !exists
  }
}

function predicateValueEquals(left: unknown, right: PredicateValue | undefined): boolean {
  return isPredicateComparableValue(left) && right !== undefined && Object.is(left, right)
}

function isPredicateComparableValue(value: unknown): value is PredicateValue {
  return (
    value === null || typeof value === "string" || typeof value === "boolean" || isNumber(value)
  )
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
