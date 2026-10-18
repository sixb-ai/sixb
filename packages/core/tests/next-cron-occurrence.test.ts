import { expect, test } from "bun:test"
import { nextCronOccurrence } from "../src/schedules"

// Each row is a distinct input class: field kinds, steps, month/year rollover, IANA time zones
// (including the US spring-forward gap), and the "never the current minute" boundary.
test.each([
  ["every minute", "* * * * *", "2026-01-01T10:30:00Z", undefined, "2026-01-01T10:31:00Z"],
  ["top of hour", "0 * * * *", "2026-01-01T10:30:00Z", undefined, "2026-01-01T11:00:00Z"],
  ["midnight each day", "0 0 * * *", "2026-01-15T23:59:00Z", undefined, "2026-01-16T00:00:00Z"],
  ["1st of each month", "0 0 1 * *", "2026-03-15T00:00:00Z", undefined, "2026-04-01T00:00:00Z"],
  // 2026-01-07 is a Wednesday; the next Monday is 2026-01-12.
  ["monday 9am", "0 9 * * 1", "2026-01-07T12:00:00Z", undefined, "2026-01-12T09:00:00Z"],
  ["step */15", "*/15 * * * *", "2026-01-01T10:07:00Z", undefined, "2026-01-01T10:15:00Z"],
  ["year boundary", "0 0 1 1 *", "2026-06-01T00:00:00Z", undefined, "2027-01-01T00:00:00Z"],
  // Midnight Paris in summer (CEST, UTC+2) is 22:00 UTC.
  [
    "Europe/Paris CEST",
    "0 0 * * *",
    "2026-07-15T21:00:00Z",
    "Europe/Paris",
    "2026-07-15T22:00:00Z",
  ],
  // 06:00 EDT (UTC-4); the next 08:30 EDT is the same day.
  [
    "America/New_York EDT",
    "30 8 * * *",
    "2026-07-01T10:00:00Z",
    "America/New_York",
    "2026-07-01T12:30:00Z",
  ],
  // 2026-03-08 02:00 EST jumps to 03:00 EDT, so 02:30 does not exist that day; next is 9 March (EDT).
  [
    "DST spring-forward skips the missing hour",
    "30 2 * * *",
    "2026-03-08T07:00:00Z",
    "America/New_York",
    "2026-03-09T06:30:00Z",
  ],
  ["exactly on a match", "0 0 * * *", "2026-01-15T00:00:00Z", undefined, "2026-01-16T00:00:00Z"],
  [
    "mid-second after a match",
    "0 0 * * *",
    "2026-01-15T00:00:30Z",
    undefined,
    "2026-01-16T00:00:00Z",
  ],
] as const)("nextCronOccurrence: %s", (_name, expression, after, timezone, expected) => {
  expect(nextCronOccurrence(expression, new Date(after), timezone)).toEqual(new Date(expected))
})
