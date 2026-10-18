import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { parseTelemetryTimestamp } from "../src/run-telemetry-projection"

// Each case asserts the absolute instant (UTC ISO) the parser must produce, or null for a value it
// must reject. The suite runs under a deliberately non-UTC TZ so that any regression back to
// local-time parsing of zone-less strings is caught regardless of the ambient timezone.
const ORIGINAL_TZ = process.env.TZ

const cases: ReadonlyArray<readonly [label: string, input: unknown, expected: string | null]> = [
  // Zone-less values are UTC.
  ["padded ISO datetime", "2026-06-01T12:00:00", "2026-06-01T12:00:00.000Z"],
  ["padded space datetime", "2026-06-01 12:00:00", "2026-06-01T12:00:00.000Z"],
  // The regression: non-zero-padded zone-less forms previously fell through to new Date() and
  // were parsed in the worker's local timezone.
  ["non-padded space datetime", "2026-6-1 12:00:00", "2026-06-01T12:00:00.000Z"],
  ["non-padded hour, no seconds", "2026-06-01 9:30", "2026-06-01T09:30:00.000Z"],
  ["fractional seconds", "2026-06-01 12:00:00.5", "2026-06-01T12:00:00.500Z"],
  ["date only", "2026-06-01", "2026-06-01T00:00:00.000Z"],
  ["surrounding whitespace", "  2026-06-01 12:00:00  ", "2026-06-01T12:00:00.000Z"],
  // An explicit zone is honored.
  ["explicit Z", "2026-06-01T12:00:00.000Z", "2026-06-01T12:00:00.000Z"],
  ["explicit offset -05:00", "2026-06-01T12:00:00-05:00", "2026-06-01T17:00:00.000Z"],
  ["explicit offset +0530", "2026-06-01T12:00:00+0530", "2026-06-01T06:30:00.000Z"],
  ["date only with Z", "2026-06-01Z", "2026-06-01T00:00:00.000Z"],
  ["valid Date instance", new Date("2026-06-01T12:00:00.000Z"), "2026-06-01T12:00:00.000Z"],
  // Out-of-range calendar and time fields are rejected, not rolled forward by new Date().
  ["month out of range", "2026-13-01 00:00:00", null],
  ["zone-less non-leap Feb 29", "2026-02-29 00:00:00", null],
  ["zoned April 31", "2026-04-31T00:00:00-05:00", null],
  ["minute out of range", "2024-05-31 09:99", null],
  ["hour 24", "2026-06-01T24:00:00", null],
  ["offset hour out of range", "2026-06-01T12:00:00+25:00", null],
  ["free-text date", "June 1, 2026", null],
  ["non-string, non-Date", 1717243200, null],
  ["invalid Date instance", new Date("nope"), null],
]

describe("parseTelemetryTimestamp", () => {
  beforeAll(() => {
    process.env.TZ = "America/New_York"
  })
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = ORIGINAL_TZ
    }
  })

  test.each(cases)("parses %s", (_label, input, expected) => {
    expect(parseTelemetryTimestamp(input)?.toISOString() ?? null).toBe(expected)
  })
})
