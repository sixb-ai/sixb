import { compareDecimalValues, isDecimalValue } from "../ontology/decimal"
import type {
  FieldPredicate,
  LinkPredicate,
  Predicate,
  PredicateValue,
  PropertyPredicate,
} from "./types"

export interface PredicateEvaluationSubject {
  readonly properties?: Readonly<Record<string, unknown>>
  readonly fields?: Readonly<Record<string, unknown>>
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
    case "field":
      return evaluateFieldPredicate(predicate, subject.fields ?? {})
    case "link":
      return evaluateLinkPredicate(predicate, subject.links ?? {})
  }
}

function evaluateFieldPredicate(
  predicate: FieldPredicate,
  fields: Readonly<Record<string, unknown>>
): boolean {
  return predicateValueEquals(fields[predicate.field], predicate.value)
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
      return compareOrderedValues(value, predicate.value, (comparison) => comparison > 0)
    case "gte":
      return compareOrderedValues(value, predicate.value, (comparison) => comparison >= 0)
    case "lt":
      return compareOrderedValues(value, predicate.value, (comparison) => comparison < 0)
    case "lte":
      return compareOrderedValues(value, predicate.value, (comparison) => comparison <= 0)
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

function compareOrderedValues(
  left: unknown,
  right: unknown,
  matches: (comparison: number) => boolean
): boolean {
  if (isNumber(left) && isNumber(right)) return matches(left - right)
  if (isDecimalValue(left) && isDecimalValue(right)) {
    return matches(compareDecimalValues(left, right))
  }
  return false
}
