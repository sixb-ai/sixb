import type { ObjectRow } from "../../storage"
import type { ObjectQueryPredicate, QueryScalarKind } from "./ir"
import { compareQueryScalarValues, queryScalarValuesEqual } from "./scalar-values"

/**
 * Whether an object's properties match a validated predicate, with the semantics every object
 * storage implements: the in-memory store and the query executor's fallback evaluate it here, and
 * so does anything that decides on an object's state without reading it.
 */
export function matchesPredicate(
  row: Pick<ObjectRow, "properties">,
  predicate: ObjectQueryPredicate
): boolean {
  switch (predicate.op) {
    case "and":
      return predicate.items.every((item) => matchesPredicate(row, item))
    case "or":
      return predicate.items.some((item) => matchesPredicate(row, item))
    case "not":
      return !matchesPredicate(row, predicate.item)
    case "constant":
      return predicate.value
    case "eq":
      return queryScalarValuesEqual(
        row.properties[predicate.propertyId],
        predicate.value,
        predicate.scalarKind
      )
    case "neq":
      return !queryScalarValuesEqual(
        row.properties[predicate.propertyId],
        predicate.value,
        predicate.scalarKind
      )
    case "lt":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) < 0
      )
    case "lte":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) <= 0
      )
    case "gt":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) > 0
      )
    case "gte":
      return (
        compareQueryScalarValues(
          row.properties[predicate.propertyId],
          predicate.value,
          predicate.scalarKind
        ) >= 0
      )
    case "in":
      return predicate.values.some((value) =>
        queryScalarValuesEqual(row.properties[predicate.propertyId], value, predicate.scalarKind)
      )
    case "exists": {
      const exists =
        Object.hasOwn(row.properties, predicate.propertyId) &&
        row.properties[predicate.propertyId] !== undefined
      return predicate.value ? exists : !exists
    }
    case "contains":
      return containsValue(
        row.properties[predicate.propertyId],
        predicate.value,
        predicate.scalarKind
      )
  }
}

function containsValue(
  actual: unknown,
  expected: unknown,
  itemScalarKind: QueryScalarKind | undefined
): boolean {
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.includes(expected)
  }

  if (Array.isArray(actual)) {
    return actual.some((item) => queryScalarValuesEqual(item, expected, itemScalarKind))
  }

  if (isPlainObject(actual) && typeof expected === "string") {
    return Object.hasOwn(actual, expected)
  }

  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
