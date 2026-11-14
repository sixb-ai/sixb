import type { DatasetDefinition, DatasetRow, MergeChange } from "@sixb/core"
import { LakeValueRefusedError } from "@sixb/core/lake-storage"
import { normalizeDuckDbDecimalValue } from "./duckdb-decimal"

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/** The dates DuckDB reads: year, month and day in that order, separated by `-` or `/`. */
const DATE_PART = String.raw`(\d{1,4})([-/])(\d{1,2})\2(\d{1,2})`

/**
 * The time DuckDB reads after one, and an offset: `Z` in capitals or numbers, never a name. The
 * offset is captured, for `normalizeDuckDbTimestampValue` to find.
 */
const TIME_PART = String.raw`(?:[T ]\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?`

export const TIMESTAMP_FORMAT = new RegExp(`^${DATE_PART}${TIME_PART}$`)
const DATE_FORMAT = new RegExp(`^${DATE_PART}$`)

/**
 * The first value DuckDB cannot hold, found without opening the lake, so `ingest` can refuse it to
 * its caller. `Date.parse` and the schema's validation accept more than DuckDB reads, such as
 * `Mon, 09 Sep 2026 10:00:00 GMT` or `2026-02-30`. `ducklake-ingest.e2e.ts` holds this against what
 * DuckDB does.
 */
export function assertDuckDbHoldsChanges(
  dataset: DatasetDefinition,
  changes: readonly MergeChange<DatasetRow, DatasetRow>[]
): void {
  for (const [changeIndex, change] of changes.entries()) {
    if (change.kind !== "upsert") continue

    for (const column of dataset.schema.columns) {
      const value = change.row[column.name]
      if (value === null || value === undefined) continue

      const refusal = refusalOf(column.type, value, column.name)
      if (refusal !== null) {
        throw new LakeValueRefusedError(
          `[SixbDuckLake] Column '${column.name}' cannot hold the value: ${refusal}`,
          { changeIndex }
        )
      }
    }
  }
}

function refusalOf(type: string, value: unknown, columnName: string): string | null {
  switch (type) {
    case "decimal":
      return decimalRefusal(value, columnName)
    case "int64":
      return int64Refusal(value)
    case "timestamp":
      return datedRefusal(value, TIMESTAMP_FORMAT, "a timestamp")
    case "date":
      return datedRefusal(value, DATE_FORMAT, "a date")
    default:
      return null
  }
}

function decimalRefusal(value: unknown, columnName: string): string | null {
  try {
    normalizeDuckDbDecimalValue(value, columnName)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function int64Refusal(value: unknown): string | null {
  const integer = typeof value === "bigint" ? value : BigInt(value as string | number)

  return integer < INT64_MIN || integer > INT64_MAX ? "it does not fit in 64 bits." : null
}

function datedRefusal(value: unknown, format: RegExp, kind: string): string | null {
  if (typeof value !== "string") return null

  const match = format.exec(value)
  if (!match) return `'${value}' is not ${kind} DuckDB reads; send an ISO 8601 value.`

  const [, year, , month, day] = match
  return isCalendarDay(Number(year), Number(month), Number(day))
    ? null
    : `'${value}' names a day that does not exist.`
}

export function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false

  // Day 0 of the next month is the last of this one. `setUTCFullYear` keeps years below 100.
  const lastDay = new Date(0)
  lastDay.setUTCFullYear(year, month, 0)

  return day <= lastDay.getUTCDate()
}
