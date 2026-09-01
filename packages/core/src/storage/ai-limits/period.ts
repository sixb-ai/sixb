import type { AiLimitPeriod } from "./types"

/** Return the UTC calendar month containing `at`, with an inclusive start and exclusive end. */
export function aiLimitCalendarMonth(at: Date): AiLimitPeriod {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new TypeError("[Sixb] AI limit period date must be a valid Date.")
  }
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))
  return { kind: "calendarMonth", start, end, resetAt: new Date(end) }
}
