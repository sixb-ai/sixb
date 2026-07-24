import { type DatasetColumnDefinition, normalizeDecimalValue, type Schema } from "@sixb/core"
import { isIntegerEnumSchema } from "./projection-schema"

export type ProjectedValueCoercionResult =
  | {
      readonly ok: true
      readonly value: unknown
    }
  | {
      readonly ok: false
      readonly errorMessage: string
    }

const finiteNumberStringPattern = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

export function normalizeProjectedValue(input: {
  readonly columnType: DatasetColumnDefinition["type"]
  readonly schema: Schema
  readonly value: unknown
}): ProjectedValueCoercionResult {
  const { columnType, schema, value } = input

  if (columnType === "int64") {
    if (isIntegerLikeSchema(schema)) {
      return coerceSafeInteger(value)
    }
  }

  if (schema === "decimal") {
    if (columnType === "int64") {
      return coerceExactDecimal(value, true)
    }

    if (columnType === "decimal") {
      return coerceExactDecimal(value, false)
    }
  }

  if (
    schema === "double" &&
    (columnType === "int64" || columnType === "decimal" || columnType === "float64")
  ) {
    return coerceFiniteNumber(value)
  }

  return { ok: true, value }
}

function coerceExactDecimal(
  value: unknown,
  allowSafeIntegerNumber: boolean
): ProjectedValueCoercionResult {
  if (typeof value === "number") {
    if (!allowSafeIntegerNumber || !Number.isSafeInteger(value)) {
      return {
        ok: false,
        errorMessage: `cannot safely coerce value ${formatProjectionValue(value)} to an exact decimal`,
      }
    }
    return normalizeExactDecimal(String(value))
  }

  if (typeof value === "bigint") {
    return normalizeExactDecimal(value.toString())
  }

  if (typeof value === "string") {
    return normalizeExactDecimal(value)
  }

  return {
    ok: false,
    errorMessage: `cannot coerce value ${formatProjectionValue(value)} to an exact decimal`,
  }
}

function normalizeExactDecimal(value: string): ProjectedValueCoercionResult {
  try {
    return { ok: true, value: normalizeDecimalValue(value) }
  } catch {
    return {
      ok: false,
      errorMessage: `cannot coerce value ${formatProjectionValue(value)} to an exact decimal`,
    }
  }
}

function coerceSafeInteger(value: unknown): ProjectedValueCoercionResult {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      return { ok: true, value }
    }

    return {
      ok: false,
      errorMessage: `cannot safely coerce value ${formatProjectionValue(value)} to a safe integer`,
    }
  }

  if (typeof value === "bigint") {
    if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return { ok: true, value: Number(value) }
    }

    return {
      ok: false,
      errorMessage: `cannot safely coerce value ${formatProjectionValue(value)} to a safe integer`,
    }
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!/^-?\d+$/.test(trimmed)) {
      return {
        ok: false,
        errorMessage: `cannot coerce value ${formatProjectionValue(value)} to an integer`,
      }
    }

    const bigint = BigInt(trimmed)
    if (bigint < BigInt(Number.MIN_SAFE_INTEGER) || bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
      return {
        ok: false,
        errorMessage: `cannot safely coerce value ${formatProjectionValue(value)} to a safe integer`,
      }
    }

    return { ok: true, value: Number(bigint) }
  }

  return {
    ok: false,
    errorMessage: `cannot coerce value ${formatProjectionValue(value)} to an integer`,
  }
}

function coerceFiniteNumber(value: unknown): ProjectedValueCoercionResult {
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return { ok: true, value }
    }

    return {
      ok: false,
      errorMessage: `cannot coerce value ${formatProjectionValue(value)} to a finite number`,
    }
  }

  if (typeof value === "bigint") {
    const number = Number(value)
    if (Number.isFinite(number)) {
      return { ok: true, value: number }
    }

    return {
      ok: false,
      errorMessage: `cannot coerce value ${formatProjectionValue(value)} to a finite number`,
    }
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    const number = finiteNumberStringPattern.test(trimmed) ? Number(trimmed) : Number.NaN
    if (Number.isFinite(number)) {
      return { ok: true, value: number }
    }

    return {
      ok: false,
      errorMessage: `cannot coerce value ${formatProjectionValue(value)} to a finite number`,
    }
  }

  return {
    ok: false,
    errorMessage: `cannot coerce value ${formatProjectionValue(value)} to a finite number`,
  }
}

function isIntegerLikeSchema(schema: Schema): boolean {
  return schema === "integer" || isIntegerEnumSchema(schema)
}

function formatProjectionValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }

  if (typeof value === "bigint") {
    return `${value.toString()}n`
  }

  return String(value)
}
