import type {
  LinkPredicateOperator,
  Predicate,
  PredicateValue,
  PropertyPredicateOperator,
} from "./types"

const propertyOperators = new Set<PropertyPredicateOperator>([
  "eq",
  "notEq",
  "gt",
  "gte",
  "lt",
  "lte",
  "isPresent",
  "isMissing",
])

const propertyValueOperators = new Set<PropertyPredicateOperator>([
  "eq",
  "notEq",
  "gt",
  "gte",
  "lt",
  "lte",
])

const linkOperators = new Set<LinkPredicateOperator>(["exists", "isMissing"])

type AssertPredicateShapeOptions = {
  readonly subject?: string
  readonly createError?: (message: string) => Error
}

function defaultError(message: string): Error {
  return new Error(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNonEmptyString(
  value: unknown,
  field: string,
  createError: (message: string) => Error
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw createError(`${field} must not be empty.`)
  }
}

export function isPredicateValue(value: unknown): value is PredicateValue {
  if (value === null) {
    return true
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
  }

  return typeof value === "string" || typeof value === "boolean"
}

/**
 * Validate the portable predicate AST shape.
 *
 * Primitive-specific validators can wrap this with their own `subject` so
 * errors read as "Rule ..." or "Trigger ..." while sharing the same checks.
 */
export function assertPredicateShape(
  value: unknown,
  options: AssertPredicateShapeOptions = {}
): asserts value is Predicate {
  const subject = options.subject ?? "Predicate"
  const createError = options.createError ?? defaultError

  if (!isRecord(value)) {
    throw createError(`${subject} predicate must be an object.`)
  }

  if (value.kind === "all" || value.kind === "any") {
    if (!Array.isArray(value.predicates)) {
      throw createError(`${subject} ${value.kind} predicate must declare predicates.`)
    }

    for (const predicate of value.predicates) {
      assertPredicateShape(predicate, options)
    }
    return
  }

  if (value.kind === "not") {
    assertPredicateShape(value.predicate, options)
    return
  }

  if (value.kind === "property") {
    assertNonEmptyString(value.propertyId, `${subject} property predicate propertyId`, createError)

    if (!propertyOperators.has(value.op as PropertyPredicateOperator)) {
      throw createError(
        `${subject} property predicate '${value.propertyId}' has invalid operator '${String(
          value.op
        )}'.`
      )
    }

    const op = value.op as PropertyPredicateOperator
    const hasValue = Object.hasOwn(value, "value")
    if (propertyValueOperators.has(op)) {
      if (!hasValue || !isPredicateValue(value.value)) {
        throw createError(
          `${subject} property predicate '${value.propertyId}' must declare a value.`
        )
      }
      return
    }

    if (hasValue) {
      throw createError(
        `${subject} property predicate '${value.propertyId}' must not declare a value.`
      )
    }
    return
  }

  if (value.kind === "link") {
    assertNonEmptyString(value.linkId, `${subject} link predicate linkId`, createError)
    if (!linkOperators.has(value.op as LinkPredicateOperator)) {
      throw createError(
        `${subject} link predicate '${value.linkId}' has invalid operator '${String(value.op)}'.`
      )
    }
    return
  }

  throw createError(`Unknown ${subject.toLowerCase()} predicate kind '${String(value.kind)}'.`)
}
