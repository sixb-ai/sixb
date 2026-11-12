const ISO_TIMESTAMP_OFFSET_PATTERN =
  /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,2})[T ]\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d+)?)?[+-]\d{2}(?::?\d{2})?$/

function isCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const lastDay = new Date(0)
  lastDay.setUTCFullYear(year, month, 0)
  return day <= lastDay.getUTCDate()
}

/**
 * Normalize a dataset timestamp value into an ISO-8601 string in UTC when it carries an offset.
 *
 * DuckDB's appender drops the UTC offset when casting a varchar into a TIMESTAMPTZ
 * column, causing timestamps with offsets (such as QuickBooks '-08:00') to lose their offset
 * and be stored hours off. Normalizing strings that carry an offset to an explicit UTC ISO string
 * ('...Z') ensures the true instant in time is preserved while letting DuckDB reject invalid dates
 * or malformed formats.
 */
export function normalizeDuckDbTimestampValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString()
  }

  if (typeof value === "string") {
    const match = ISO_TIMESTAMP_OFFSET_PATTERN.exec(value)
    if (match) {
      const [, year, month, day] = match
      if (isCalendarDay(Number(year), Number(month), Number(day))) {
        const parsed = new Date(value)
        if (!Number.isNaN(parsed.getTime())) {
          return parsed.toISOString()
        }
      }
    }
  }

  return String(value)
}
