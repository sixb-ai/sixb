import { type CronFieldMatcher, createCronFieldMatcher } from "./cron"
import { CronValidationError } from "./errors"

const MAX_SEARCH_MS = 4 * 365.25 * 24 * 60 * 60 * 1000 // ~4 years

interface LocalComponents {
  minute: number
  hour: number
  dayOfMonth: number
  month: number // 1-based
  dayOfWeek: number // 0=Sunday
}

function getLocalComponents(date: Date, timezone: string | undefined): LocalComponents {
  if (timezone === undefined) {
    return {
      minute: date.getUTCMinutes(),
      hour: date.getUTCHours(),
      dayOfMonth: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      dayOfWeek: date.getUTCDay(),
    }
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type)
    if (!part) throw new CronValidationError(`Failed to extract ${type} for timezone ${timezone}.`)
    return part.value
  }

  const weekdayStr = get("weekday")
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }

  return {
    minute: Number.parseInt(get("minute"), 10),
    hour: Number.parseInt(get("hour"), 10) % 24,
    dayOfMonth: Number.parseInt(get("day"), 10),
    month: Number.parseInt(get("month"), 10),
    dayOfWeek: weekdayMap[weekdayStr] ?? 0,
  }
}

function matchesDay(
  dayOfMonth: CronFieldMatcher,
  dayOfWeek: CronFieldMatcher,
  comp: LocalComponents
): boolean {
  const domMatches = dayOfMonth.matches(comp.dayOfMonth)
  const dowMatches = dayOfWeek.matches(comp.dayOfWeek)

  if (dayOfMonth.isAny || dayOfWeek.isAny) {
    return domMatches && dowMatches
  }
  return domMatches || dowMatches
}

/**
 * Compute the next occurrence of a cron expression after `after`.
 *
 * The returned Date is always in UTC. When `timezone` is provided, the cron
 * fields are evaluated against wall-clock time in that timezone.
 *
 * The current minute is never returned — the earliest possible result is
 * `after` rounded up to the next whole minute.
 */
export function nextCronOccurrence(expression: string, after: Date, timezone?: string): Date {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronValidationError(
      `Invalid cron expression '${expression}'. Expected 5 fields (minute hour day month weekday).`
    )
  }

  const [minuteField, hourField, dayOfMonthField, monthField, dayOfWeekField] = parts

  const minuteMatcher = createCronFieldMatcher({
    field: minuteField,
    min: 0,
    max: 59,
    fieldName: "minute",
  })
  const hourMatcher = createCronFieldMatcher({
    field: hourField,
    min: 0,
    max: 23,
    fieldName: "hour",
  })
  const dayOfMonthMatcher = createCronFieldMatcher({
    field: dayOfMonthField,
    min: 1,
    max: 31,
    fieldName: "day-of-month",
  })
  const monthMatcher = createCronFieldMatcher({
    field: monthField,
    min: 1,
    max: 12,
    fieldName: "month",
  })
  const dayOfWeekMatcher = createCronFieldMatcher({
    field: dayOfWeekField,
    min: 0,
    max: 6,
    fieldName: "day-of-week",
    normalize: (value) => (value === 7 ? 0 : value),
  })

  // Start from the next whole minute after `after`
  const startMs = after.getTime()
  let candidateMs = Math.ceil(startMs / 60_000) * 60_000
  if (candidateMs <= startMs) candidateMs += 60_000

  const limitMs = startMs + MAX_SEARCH_MS

  while (candidateMs <= limitMs) {
    const candidate = new Date(candidateMs)
    const comp = getLocalComponents(candidate, timezone)

    // Month check — skip ahead if no match
    if (!monthMatcher.matches(comp.month)) {
      if (timezone === undefined) {
        const next = findNextMatchingMonth(candidate, monthMatcher)
        candidateMs = next.getTime()
      } else {
        // Skip to next local day boundary, then continue
        candidateMs += ((24 - comp.hour) * 60 - comp.minute) * 60_000
      }
      continue
    }

    // Day check — skip ahead if no match
    if (!matchesDay(dayOfMonthMatcher, dayOfWeekMatcher, comp)) {
      if (timezone === undefined) {
        const next = new Date(candidateMs)
        next.setUTCDate(next.getUTCDate() + 1)
        next.setUTCHours(0, 0, 0, 0)
        candidateMs = next.getTime()
      } else {
        // Skip to next local day boundary
        candidateMs += ((24 - comp.hour) * 60 - comp.minute) * 60_000
      }
      continue
    }

    // Hour check — skip ahead if no match
    if (!hourMatcher.matches(comp.hour)) {
      if (timezone === undefined) {
        const next = new Date(candidateMs)
        next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0)
        candidateMs = next.getTime()
      } else {
        // Skip to next local hour boundary
        candidateMs += (60 - comp.minute) * 60_000
      }
      continue
    }

    // Minute check
    if (!minuteMatcher.matches(comp.minute)) {
      candidateMs += 60_000
      continue
    }

    return candidate
  }

  throw new CronValidationError(`No matching occurrence found for '${expression}' within 4 years.`)
}

function findNextMatchingMonth(current: Date, monthMatcher: CronFieldMatcher): Date {
  const d = new Date(current)
  d.setUTCDate(1)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCMonth(d.getUTCMonth() + 1)

  for (let i = 0; i < 48; i++) {
    if (monthMatcher.matches(d.getUTCMonth() + 1)) {
      return d
    }
    d.setUTCMonth(d.getUTCMonth() + 1)
  }

  return d
}
