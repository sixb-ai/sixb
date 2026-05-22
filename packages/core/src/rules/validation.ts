import type { OntologyRegistry } from "../ontology/registry"
import type { ObjectType } from "../ontology/types"
import { RuleValidationError } from "./errors"
import type {
  RuleDefinition,
  RuleLinkOperator,
  RulePredicate,
  RulePropertyOperator,
  RuleValue,
} from "./types"

const propertyOperators = new Set<RulePropertyOperator>([
  "eq",
  "notEq",
  "gt",
  "gte",
  "lt",
  "lte",
  "isPresent",
  "isMissing",
])

const propertyValueOperators = new Set<RulePropertyOperator>([
  "eq",
  "notEq",
  "gt",
  "gte",
  "lt",
  "lte",
])

const linkOperators = new Set<RuleLinkOperator>(["exists", "isMissing"])

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

export function isRuleValue(value: unknown): value is RuleValue {
  if (value === null) {
    return true
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
  }

  return typeof value === "string" || typeof value === "boolean"
}

/**
 * Validate only the portable AST shape.
 *
 * This is used by discovery/type guards and by the builder after `.where(...)`.
 * Ontology-aware checks live in `validateRulesAtStartup`, once the full
 * registry has inherited properties and links resolved.
 */
export function assertRulePredicateShape(
  value: unknown,
  createError: (message: string) => Error = (message) => new RuleValidationError(message)
): asserts value is RulePredicate {
  if (!isRecord(value)) {
    throw createError("Rule predicate must be an object.")
  }

  if (value.kind === "all" || value.kind === "any") {
    if (!Array.isArray(value.predicates)) {
      throw createError(`Rule ${value.kind} predicate must declare predicates.`)
    }

    for (const predicate of value.predicates) {
      assertRulePredicateShape(predicate, createError)
    }
    return
  }

  if (value.kind === "not") {
    assertRulePredicateShape(value.predicate, createError)
    return
  }

  if (value.kind === "property") {
    assertNonEmptyString(value.propertyId, "Rule property predicate propertyId", createError)

    if (!propertyOperators.has(value.op as RulePropertyOperator)) {
      throw createError(
        `Rule property predicate '${value.propertyId}' has invalid operator '${String(value.op)}'.`
      )
    }

    const op = value.op as RulePropertyOperator
    const hasValue = Object.hasOwn(value, "value")
    if (propertyValueOperators.has(op)) {
      if (!hasValue || !isRuleValue(value.value)) {
        throw createError(`Rule property predicate '${value.propertyId}' must declare a value.`)
      }
      return
    }

    if (hasValue) {
      throw createError(`Rule property predicate '${value.propertyId}' must not declare a value.`)
    }
    return
  }

  if (value.kind === "link") {
    assertNonEmptyString(value.linkId, "Rule link predicate linkId", createError)
    if (!linkOperators.has(value.op as RuleLinkOperator)) {
      throw createError(
        `Rule link predicate '${value.linkId}' has invalid operator '${String(value.op)}'.`
      )
    }
    return
  }

  throw createError(`Unknown rule predicate kind '${String(value.kind)}'.`)
}

/** Validate the serializable rule envelope without consulting ontology state. */
export function assertRuleDefinition(
  value: unknown,
  createError: (message: string) => Error = (message) => new RuleValidationError(message)
): asserts value is RuleDefinition {
  if (!isRecord(value)) {
    throw createError("Rule definition must be an object.")
  }

  if (value.kind !== "rule") {
    throw createError("Rule definition kind must be 'rule'.")
  }

  assertNonEmptyString(value.id, "Rule id", createError)

  if (!isRecord(value.subject) || value.subject.kind !== "object") {
    throw createError(`Rule '${value.id}' subject must be an object subject.`)
  }

  assertNonEmptyString(
    value.subject.objectTypeId,
    `Rule '${value.id}' subject objectTypeId`,
    createError
  )
  assertRulePredicateShape(value.predicate, createError)
}

export function isRuleDefinition(value: unknown): value is RuleDefinition {
  try {
    assertRuleDefinition(value, (message) => new Error(message))
    return true
  } catch {
    return false
  }
}

/**
 * Validate rules after the ontology registry is built.
 *
 * Startup is where we can reject references that cannot be known from the
 * serialized rule alone: duplicate ids, unknown subject types, unknown
 * properties/links, and empty logical groups.
 */
export function validateRulesAtStartup(
  rules: readonly RuleDefinition[],
  ontology: OntologyRegistry
): void {
  const seenRuleIds = new Set<string>()

  for (const rule of rules) {
    assertRuleDefinition(rule)

    if (seenRuleIds.has(rule.id)) {
      throw new RuleValidationError(`Duplicate rule id: ${rule.id}`)
    }
    seenRuleIds.add(rule.id)

    const objectType = ontology.getObjectTypeById(rule.subject.objectTypeId)
    if (!objectType) {
      throw new RuleValidationError(
        `Rule "${rule.id}": unknown object type "${rule.subject.objectTypeId}".`
      )
    }

    validatePredicateAgainstSubject(rule, objectType, rule.predicate)
  }
}

/** Walk every predicate node and check subject-scoped references. */
function validatePredicateAgainstSubject(
  rule: RuleDefinition,
  objectType: ObjectType,
  predicate: RulePredicate
): void {
  if (predicate.kind === "all" || predicate.kind === "any") {
    if (predicate.predicates.length === 0) {
      throw new RuleValidationError(
        `Rule "${rule.id}": ${predicate.kind} predicate must contain at least one predicate.`
      )
    }

    for (const child of predicate.predicates) {
      validatePredicateAgainstSubject(rule, objectType, child)
    }
    return
  }

  if (predicate.kind === "not") {
    validatePredicateAgainstSubject(rule, objectType, predicate.predicate)
    return
  }

  if (predicate.kind === "property") {
    const propertyIds = new Set(objectType.properties.map((property) => property.id))
    if (!propertyIds.has(predicate.propertyId)) {
      throw new RuleValidationError(
        `Rule "${rule.id}": unknown property "${predicate.propertyId}" on object type "${objectType.id}".`
      )
    }
    return
  }

  const linkIds = new Set(objectType.links.map((link) => link.id))
  if (!linkIds.has(predicate.linkId)) {
    throw new RuleValidationError(
      `Rule "${rule.id}": unknown link "${predicate.linkId}" on object type "${objectType.id}".`
    )
  }
}
