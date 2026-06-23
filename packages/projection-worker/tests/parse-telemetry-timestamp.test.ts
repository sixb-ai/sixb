import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { parseTelemetryTimestamp } from "../src/run-telemetry-projection"

// Each case asserts the absolute instant (UTC ISO) the parser must produce. The
// suite runs under a deliberately non-UTC TZ so that any regression back to
// local-time parsing of zone-less strings is caught regardless of the ambient
// timezone the test happens to run in.
const ORIGINAL_TZ = process.env.TZ

const utcCases: ReadonlyArray<readonly [label: string, input: unknown, expected: string]> = [
  ["padded ISO datetime", "2026-06-01T12:00:00", "2026-06-01T12:00:00.000Z"],
  ["padded space datetime", "2026-06-01 12:00:00", "2026-06-01T12:00:00.000Z"],
  // The regression: non-zero-padded zone-less forms previously fell through to
  // new Date() and were parsed in the worker's local timezone.
  ["non-padded space datetime", "2026-6-1 12:00:00", "2026-06-01T12:00:00.000Z"],
  ["non-padded, no seconds", "2026-06-01 9:30", "2026-06-01T09:30:00.000Z"],
  ["fractional seconds", "2026-06-01 12:00:00.5", "2026-06-01T12:00:00.500Z"],
  ["date-only padded", "2026-06-01", "2026-06-01T00:00:00.000Z"],
  ["date-only non-padded", "2026-6-1", "2026-06-01T00:00:00.000Z"],
  ["surrounding whitespace", "  2026-06-01 12:00:00  ", "2026-06-01T12:00:00.000Z"],
]

const zonedCases: ReadonlyArray<readonly [label: string, input: string, expected: string]> = [
  ["explicit Z", "2026-06-01T12:00:00.000Z", "2026-06-01T12:00:00.000Z"],
  ["explicit offset -05:00", "2026-06-01T12:00:00-05:00", "2026-06-01T17:00:00.000Z"],
  ["explicit offset +0530", "2026-06-01T12:00:00+0530", "2026-06-01T06:30:00.000Z"],
  // The component-based parser still resolves zoned forms it does not hand to
  // new Date(): space separator with Z, non-padded fields, and date-only Z.
  ["space separator with Z", "2026-06-01 12:00:00Z", "2026-06-01T12:00:00.000Z"],
  ["non-padded with offset", "2026-6-1 9:00:00+02:00", "2026-06-01T07:00:00.000Z"],
  ["date-only Z", "2026-06-01Z", "2026-06-01T00:00:00.000Z"],
]

const rejectedCases: ReadonlyArray<readonly [label: string, input: unknown]> = [
  ["calendar rollover", "2026-13-01 00:00:00"],
  // B1: out-of-range calendar dates must be rejected on the zoned path too, not
  // silently rolled forward by new Date() (Feb 29 of a non-leap year, Apr 31).
  ["zoned non-leap Feb 29", "2026-02-29T00:00:00Z"],
  ["zoned April 31 with offset", "2026-04-31T00:00:00-05:00"],
  ["zone-less non-leap Feb 29", "2026-02-29 00:00:00"],
  // B2: out-of-range time fields must be rejected, not rolled within the day.
  ["minute out of range", "2024-05-31 09:99"],
  ["second out of range", "2024-05-31 09:30:99"],
  ["hour out of range", "2026-06-01T24:00:00"],
  ["offset hour out of range", "2026-06-01T12:00:00+25:00"],
  ["slash format", "06/01/2026"],
  ["free-text date", "June 1, 2026"],
  ["non-string, non-Date", 1717243200],
  ["null", null],
  ["empty string", ""],
  ["invalid Date instance", new Date("nope")],
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

  test.each(utcCases)("interprets zone-less %s as UTC", (_label, input, expected) => {
    expect(parseTelemetryTimestamp(input)?.toISOString()).toBe(expected)
  })

  test.each(zonedCases)("honors the explicit zone of %s", (_label, input, expected) => {
    expect(parseTelemetryTimestamp(input)?.toISOString()).toBe(expected)
  })

  test.each(rejectedCases)("rejects %s as null", (_label, input) => {
    expect(parseTelemetryTimestamp(input)).toBeNull()
  })

  test("passes a valid Date instance through unchanged", () => {
    const instant = new Date("2026-06-01T12:00:00.000Z")
    expect(parseTelemetryTimestamp(instant)).toBe(instant)
  })
})
