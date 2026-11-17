/**
 * Calendar arithmetic in an IANA time zone.
 *
 * A period of a zone's calendar is not a fixed number of milliseconds: where a zone changes its
 * clocks a day lasts 23 or 25 hours, and a zone such as Asia/Kolkata starts its hours half past a
 * UTC hour. Usage buckets are whole periods of the reader's calendar, so the queried range, the
 * bars and the calls in them all go through these functions.
 */

/** An hour, a day, or a week starting Monday: the periods a usage chart is drawn in. */
export type CalendarPeriod = "hour" | "day" | "week"

/** The zone a project assumes when it sets none, and the one a calendar defaults to. */
export const DEFAULT_PROJECT_TIME_ZONE = "UTC"

/** A period of the calendar: a start and the start of the one after it. */
export interface CalendarPeriodRange {
  readonly start: Date
  readonly end: Date
}

/** A period wider than this many is a caller's mistake, not a chart. */
const MAX_PERIODS = 10_000

const hourMs = 60 * 60 * 1000
const dayMs = 24 * hourMs

/** The canonical IANA name of a time zone (`europe/paris` → `Europe/Paris`), or `undefined`. */
export function canonicalTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() !== value || value === "") return undefined
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

// Buckets are formatted for every call and every period of a range, so one formatter per zone is
// built once: constructing one costs more than reading several of them.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/** The zone's wall clock at an instant, as the milliseconds `Date.UTC` gives for its fields. */
function wallClockOf(at: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(at)
  const field = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((candidate) => candidate.type === type)
    if (!part) throw new TypeError(`[Sixb] ${timeZone} did not read back a ${type}.`)
    return Number(part.value)
  }
  return Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second")
  )
}

/** How far the zone's wall clock runs ahead of UTC at an instant. */
function offsetOf(at: Date, timeZone: string): number {
  return wallClockOf(at, timeZone) - Math.floor(at.getTime() / 1000) * 1000
}

/**
 * The instant a zone's wall clock reads `wallClock`.
 *
 * A wall clock the zone skips is met at the jump that skipped it, and one it reads twice starts the
 * period at its first reading, so periods stay in order and whole.
 */
function instantOf(wallClock: number, timeZone: string): Date {
  const before = offsetOf(new Date(wallClock - dayMs), timeZone)
  const after = offsetOf(new Date(wallClock + dayMs), timeZone)
  if (before === after) return new Date(wallClock - before)
  const candidates = [wallClock - before, wallClock - after].sort((left, right) => left - right)
  const found = candidates.find((instant) => wallClockOf(new Date(instant), timeZone) >= wallClock)
  return new Date(found ?? candidates[candidates.length - 1]!)
}

/**
 * The zone's wall clock at an instant, spelled as `wallClockInstant` reads it back:
 * `2026-11-14T05:00:00.000Z` in America/New_York is `2026-11-14T00:00:00.000Z`.
 */
export function wallClockAt(at: Date, timeZone = DEFAULT_PROJECT_TIME_ZONE): string {
  return new Date(wallClockOf(at, timeZone)).toISOString()
}

/**
 * The instant a zone's wall clock names.
 *
 * `wallClock` is an ISO 8601 string whose `Z` marks the wall clock rather than UTC, as a provider
 * reads it out of a query without a time zone: `2026-11-14T00:00:00Z` is midnight in the zone.
 */
export function wallClockInstant(wallClock: string, timeZone = DEFAULT_PROJECT_TIME_ZONE): Date {
  const wall = Date.parse(wallClock)
  if (Number.isNaN(wall)) {
    throw new TypeError(`[Sixb] ${JSON.stringify(wallClock)} is not a wall clock time.`)
  }
  return instantOf(wall, timeZone)
}

/**
 * The wall clock a period of the calendar is named by: its hour, its midnight, or its Monday's.
 *
 * It is the name even where the zone skips it, so a period that began at the jump still steps to
 * the next midnight rather than to the next 1 am.
 */
function periodWallClock(wallClock: number, period: CalendarPeriod): number {
  if (period === "hour") return wallClock - (wallClock % hourMs)
  const midnight = wallClock - (wallClock % dayMs)
  if (period === "day") return midnight

  // Weeks begin on Monday, which is what a date truncated to its week gives everywhere else.
  const mondayOffset = (new Date(midnight).getUTCDay() + 6) % 7
  return midnight - mondayOffset * dayMs
}

/** The start of the period an instant falls in, on the zone's calendar. */
export function calendarPeriodStart(
  at: Date,
  period: CalendarPeriod,
  timeZone = DEFAULT_PROJECT_TIME_ZONE
): Date {
  return instantOf(periodWallClock(wallClockOf(at, timeZone), period), timeZone)
}

/**
 * The start of the period `count` periods away from the one `at` falls in.
 *
 * Stepping the zone's wall clock keeps every period whole across a change of clocks, where adding
 * milliseconds would land an hour off a boundary.
 */
export function addCalendarPeriods(
  at: Date,
  period: CalendarPeriod,
  count: number,
  timeZone = DEFAULT_PROJECT_TIME_ZONE
): Date {
  const step = period === "hour" ? hourMs : period === "week" ? 7 * dayMs : dayMs
  const start = periodWallClock(wallClockOf(at, timeZone), period)
  return instantOf(start + count * step, timeZone)
}

/**
 * Every period of [from, to), starting with the one `from` falls in.
 *
 * A wall clock the zone skips begins its period where the clocks jump, which keeps the periods
 * contiguous through the hour the zone never had.
 */
export function calendarPeriods(
  from: Date,
  to: Date,
  period: CalendarPeriod,
  timeZone = DEFAULT_PROJECT_TIME_ZONE
): readonly CalendarPeriodRange[] {
  const periods: CalendarPeriodRange[] = []
  let start = calendarPeriodStart(from, period, timeZone)
  while (start.getTime() < to.getTime()) {
    if (periods.length >= MAX_PERIODS) {
      throw new RangeError(`[Sixb] The range holds more than ${MAX_PERIODS} ${period} periods.`)
    }
    const end = addCalendarPeriods(start, period, 1, timeZone)
    periods.push({ start, end })
    start = end
  }
  return periods
}
