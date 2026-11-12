/**
 * Normalize a dataset timestamp value into an ISO-8601 string in UTC.
 *
 * DuckDB's appender drops the UTC offset when casting a varchar into a TIMESTAMPTZ
 * column, causing timestamps with offsets (such as QuickBooks '-08:00') to lose their offset
 * and be stored hours off. Normalizing to an explicit UTC ISO string ('...Z') ensures the
 * true instant in time is preserved.
 */
export function normalizeDuckDbTimestampValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === "string") {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  }

  return String(value)
}
