import { isCalendarDay, TIMESTAMP_FORMAT } from "./value-limits"

/**
 * The string to append for a `timestamp` value. DuckDB's appender drops a numeric UTC offset when
 * it casts a varchar into a TIMESTAMPTZ column, so `2017-01-02T09:51:02-08:00` would be stored
 * eight hours early. A string carrying one is rewritten in UTC (`...Z`), at millisecond precision.
 * Anything else passes through for DuckDB to read or refuse, including a day that does not exist.
 */
export function normalizeDuckDbTimestampValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== "string") return String(value)

  const match = TIMESTAMP_FORMAT.exec(value)
  if (!match) return value

  const [, year, , month, day, offset] = match
  if (offset === undefined || offset === "Z") return value
  if (!isCalendarDay(Number(year), Number(month), Number(day))) return value

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}
