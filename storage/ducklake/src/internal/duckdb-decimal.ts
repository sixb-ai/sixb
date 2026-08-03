import { type DecimalValue, normalizeDecimalValue } from "@sixb/core"
import { SixbError } from "@sixb/core/errors"
import { DUCKDB_COLUMN_TYPES } from "./duckdb-column-types"

const decimalType = DUCKDB_COLUMN_TYPES.decimal
const maxIntegerDigits = decimalType.precision - decimalType.scale

/**
 * Normalize a dataset decimal and reject values DuckDB would round or overflow.
 */
export function normalizeDuckDbDecimalValue(value: unknown, columnName: string): DecimalValue {
  if (typeof value !== "string") {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] Decimal column '${columnName}' must be an exact decimal string.`
    )
  }

  let normalized: DecimalValue
  try {
    normalized = normalizeDecimalValue(value)
  } catch {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] Decimal column '${columnName}' must be an exact decimal string.`
    )
  }

  const unsigned = normalized.startsWith("-") ? normalized.slice(1) : normalized
  const [integer, fraction = ""] = unsigned.split(".")
  if (integer.length > maxIntegerDigits || fraction.length > decimalType.scale) {
    throw new SixbError(
      "storage.lake_failed",
      `[SixbDuckLake] Decimal column '${columnName}' cannot be represented exactly as ${decimalType.sql}; expected at most ${maxIntegerDigits} integer digits and ${decimalType.scale} fractional digits.`
    )
  }

  return normalized
}
