import type { DatasetDefinition } from "./types"

const MIN_INT64 = -(1n << 63n)
const MAX_INT64 = (1n << 63n) - 1n

/** Normalize source ordering to an exact integer (timestamp milliseconds or signed int64). */
export function datasetSequenceValue(dataset: DatasetDefinition, value: unknown): bigint {
  const column = dataset.schema.columns.find((column) => column.name === dataset.sequenceBy)
  if (column?.type === "int64") {
    if (
      (typeof value === "number" && Number.isSafeInteger(value)) ||
      (typeof value === "string" && /^-?\d+$/.test(value))
    ) {
      const integer = BigInt(value)
      if (integer >= MIN_INT64 && integer <= MAX_INT64) return integer
    }
    throw new Error(
      `Dataset '${dataset.id}' sequence must be a signed int64; use a string outside the safe integer range.`
    )
  }
  if (column?.type === "timestamp") {
    const millis = parseDatasetTimestamp(value)
    if (millis !== null) return BigInt(millis)
    throw new Error(
      `Dataset '${dataset.id}' sequence must be a valid Date or ISO timestamp with an explicit timezone and at most millisecond precision.`
    )
  }
  throw new Error(
    `Dataset '${dataset.id}' sequenceBy must reference a non-nullable timestamp or int64 column.`
  )
}

/** Date.parse alone normalizes impossible calendar dates instead of rejecting them. */
export function parseDatasetTimestamp(value: unknown): number | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime()
  if (typeof value === "string") {
    const match =
      /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(
        value
      )
    if (match) {
      const [, year, month, day, hour, minute, second, , zone] = match
      const numericYear = Number(year)
      const leapYear = numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0)
      const days =
        Number(month) === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(Number(month)) ? 30 : 31
      const validZone =
        zone === "Z" || (Number(zone?.slice(1, 3)) <= 23 && Number(zone?.slice(4)) <= 59)
      const millis = Date.parse(value)
      if (
        Number(month) >= 1 &&
        Number(month) <= 12 &&
        Number(day) >= 1 &&
        Number(day) <= days &&
        Number(hour) < 24 &&
        Number(minute) < 60 &&
        Number(second) < 60 &&
        validZone &&
        Number.isFinite(millis)
      )
        return millis
    }
  }
  return null
}

export function getDatasetSequenceValidationError(
  dataset: DatasetDefinition,
  value: unknown
): string | null {
  try {
    datasetSequenceValue(dataset, value)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
