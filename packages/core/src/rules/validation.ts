import { SixbError } from "../errors"
import type { OntologyRegistry } from "../ontology/registry"
import type { ObjectType } from "../ontology/types"
import { assertPredicateShape, isPredicateValue } from "../predicates"
import type { RuleDefinition, RulePredicate, RuleValue } from "./types"

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
  return isPredicateValue(value)
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
  createError: (message: string) => Error = (message) =>
    new SixbError("runtime.invalid_definition", message)
): asserts value is RulePredicate {
  assertPredicateShape(value, { subject: "Rule", createError })
}

/** Validate the serializable rule envelope without consulting ontology state. */
export function assertRuleDefinition(
  value: unknown,
  createError: (message: string) => Error = (message) =>
    new SixbError("runtime.invalid_definition", message)
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
      throw new SixbError("runtime.invalid_definition", `Duplicate rule id: ${rule.id}`)
    }
    seenRuleIds.add(rule.id)

    const objectType = ontology.getObjectTypeById(rule.subject.objectTypeId)
    if (!objectType) {
      throw new SixbError(
        "runtime.invalid_definition",
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
      throw new SixbError(
        "runtime.invalid_definition",
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
      throw new SixbError(
        "runtime.invalid_definition",
        `Rule "${rule.id}": unknown property "${predicate.propertyId}" on object type "${objectType.id}".`
      )
    }
    return
  }

  if (predicate.kind === "field") {
    throw new SixbError(
      "runtime.invalid_definition",
      `Rule "${rule.id}": field predicates are not supported in rule conditions.`
    )
  }

  const linkIds = new Set(objectType.links.map((link) => link.id))
  if (!linkIds.has(predicate.linkId)) {
    throw new SixbError(
      "runtime.invalid_definition",
      `Rule "${rule.id}": unknown link "${predicate.linkId}" on object type "${objectType.id}".`
    )
  }
}
