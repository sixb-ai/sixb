/**
 * Core interfaces for the quantitative types system.
 *
 * Two layers model physical quantities:
 * - **Unit** — a specific unit of measurement (e.g. degree Celsius).
 * - **QuantitativeType** — a physical quantity with its valid units (e.g. Temperature).
 *
 * Inspired by Azure DTDL QuantitativeTypes v2.
 */

/** A specific unit of measurement. */
export interface Unit {
  /** Human-readable name, e.g. "Degree Celsius". */
  readonly name: string
  /** Display symbol, e.g. "°C". */
  readonly symbol: string
}

/** A physical quantity or measurement concept with its valid units. */
export interface QuantitativeType {
  /** Human-readable name, e.g. "Temperature". */
  readonly name: string
  /** Description of what this quantity measures. */
  readonly description: string
  /** Valid units for this quantity, keyed by unit id. */
  readonly units: Record<string, Unit>
}
