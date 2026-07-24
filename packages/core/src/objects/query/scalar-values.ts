import { compareDecimalValues } from "../../ontology"
import type { QueryScalarKind } from "./ir"

/** Compare two values according to the scalar schema resolved by query validation. */
export function compareQueryScalarValues(
  left: unknown,
  right: unknown,
  scalarKind?: QueryScalarKind
): number {
  if (left === undefined || right === undefined || left === null || right === null) {
    return Number.NaN
  }

  if (scalarKind === undefined) return compareRuntimeValues(left, right)

  switch (scalarKind) {
    case "string":
    case "uuid":
      return typeof left === "string" && typeof right === "string"
        ? compareStrings(left, right)
        : Number.NaN
    case "boolean":
      return typeof left === "boolean" && typeof right === "boolean"
        ? Number(left) - Number(right)
        : Number.NaN
    case "integer":
    case "double":
      return typeof left === "number" && typeof right === "number" ? left - right : Number.NaN
    case "decimal":
      return typeof left === "string" && typeof right === "string"
        ? compareDecimalValues(left, right)
        : Number.NaN
    case "date":
    case "timestamp":
      return compareTemporalValues(left, right)
  }
}

/** Test equality with the same schema semantics used for ordered comparisons. */
export function queryScalarValuesEqual(
  left: unknown,
  right: unknown,
  scalarKind?: QueryScalarKind
): boolean {
  if (scalarKind === "decimal") {
    const comparison = compareQueryScalarValues(left, right, scalarKind)
    return !Number.isNaN(comparison) && comparison === 0
  }

  if (scalarKind === "date" || scalarKind === "timestamp") {
    const comparison = compareTemporalValues(left, right)
    return !Number.isNaN(comparison) && comparison === 0
  }

  if (scalarKind !== undefined) return Object.is(left, right)
  return runtimeValuesEqual(left, right)
}

function compareRuntimeValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right
  if (typeof left === "string" && typeof right === "string") return compareStrings(left, right)
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right)
  }
  if (left instanceof Date || right instanceof Date) return compareTemporalValues(left, right)
  return Number.NaN
}

function runtimeValuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date) {
    const comparison = compareTemporalValues(left, right)
    return !Number.isNaN(comparison) && comparison === 0
  }
  return Object.is(left, right)
}

function compareTemporalValues(left: unknown, right: unknown): number {
  const leftTime = dateTime(left)
  const rightTime = dateTime(right)
  if (leftTime === null || rightTime === null) return Number.NaN
  return leftTime - rightTime
}

function dateTime(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }
  if (typeof value === "string" || typeof value === "number") {
    const time = new Date(value).getTime()
    return Number.isNaN(time) ? null : time
  }
  return null
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
