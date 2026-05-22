/**
 * Pario Quantitative Types — public API.
 *
 * Two concepts:
 * - **QuantitativeType** — a physical quantity with its valid units.
 * - **Unit** — a specific unit of measurement.
 *
 * ```ts
 * import { quantitativeTypes, getUnit, isValidUnit } from "@pario/core"
 *
 * // Browse what's available
 * quantitativeTypes.Temperature.units.degreeCelsius.symbol // "°C"
 *
 * // Validate a unit against a quantity
 * isValidUnit("Temperature", "degreeCelsius") // true
 * isValidUnit("Temperature", "millibar")      // false
 * ```
 */

// ── Core interfaces ─────────────────────────────────────────

export type { QuantitativeType, Unit } from "./types"

// ── Registry + derived types ────────────────────────────────

export type { QuantitativeTypeId, UnitId, UnitsOf } from "./quantitative-types"
export { quantitativeTypes } from "./quantitative-types"

// ── Helper functions ────────────────────────────────────────

import type { QuantitativeTypeId, UnitId } from "./quantitative-types"
import { quantitativeTypes } from "./quantitative-types"
import type { Unit } from "./types"

/** Flat lookup: unit id → { unit data, quantitative type id }. Built once on import. */
const unitIndex: Map<string, Unit & { quantitativeTypeId: string }> = new Map()

for (const [qtId, qt] of Object.entries(quantitativeTypes)) {
  for (const [unitId, unit] of Object.entries(qt.units)) {
    // A unit id may appear under multiple quantities (e.g. densityUnits).
    // Store the first occurrence; the data is identical since they share the
    // same const object.
    if (!unitIndex.has(unitId)) {
      unitIndex.set(unitId, { ...unit, quantitativeTypeId: qtId })
    }
  }
}

/**
 * Look up a unit by its id.
 *
 * @example
 * ```ts
 * const u = getUnit("degreeCelsius")
 * // => { name: "Degree Celsius", symbol: "°C", quantitativeTypeId: "Temperature" }
 * ```
 */
export function getUnit(unitId: string): (Unit & { quantitativeTypeId: string }) | undefined {
  return unitIndex.get(unitId)
}

/**
 * Get the record of valid units for a quantitative type.
 *
 * @example
 * ```ts
 * const units = getUnitsFor("Temperature")
 * // => { degreeCelsius: { … }, degreeFahrenheit: { … }, kelvin: { … } }
 * ```
 */
export function getUnitsFor(quantitativeTypeId: string): Record<string, Unit> | undefined {
  const qt = quantitativeTypes[quantitativeTypeId as QuantitativeTypeId]
  return qt?.units as Record<string, Unit> | undefined
}

/**
 * Check whether a unit id is valid for a given quantitative type.
 *
 * @example
 * ```ts
 * isValidUnit("Temperature", "degreeCelsius") // true
 * isValidUnit("Temperature", "millibar")      // false
 * ```
 */
export function isValidUnit(quantitativeTypeId: string, unitId: string): boolean {
  const units = getUnitsFor(quantitativeTypeId)
  return units != null && unitId in units
}

/**
 * Get the display symbol for a unit id.
 *
 * @example
 * ```ts
 * getUnitSymbol("degreeCelsius") // "°C"
 * getUnitSymbol("unknown")       // undefined
 * ```
 */
export function getUnitSymbol(unitId: string): string | undefined {
  return unitIndex.get(unitId)?.symbol
}

/**
 * Type guard: checks if a string is a valid `QuantitativeTypeId`.
 */
export function isQuantitativeTypeId(value: string): value is QuantitativeTypeId {
  return value in quantitativeTypes
}

/**
 * Type guard: checks if a string is a valid `UnitId`.
 */
export function isUnitId(value: string): value is UnitId {
  return unitIndex.has(value)
}
