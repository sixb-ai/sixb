import { describe, expect, test } from "bun:test"
import { normalizeDuckDbTimestampValue } from "../src/internal/duckdb-timestamp"

describe("normalizeDuckDbTimestampValue", () => {
  test("normalizes timestamp strings with negative offsets to UTC", () => {
    // QuickBooks sends timestamps with Pacific offset (-08:00)
    expect(normalizeDuckDbTimestampValue("2017-01-02T09:51:02-08:00")).toBe(
      "2017-01-02T17:51:02.000Z"
    )
    expect(normalizeDuckDbTimestampValue("2024-06-15T12:00:00-05:00")).toBe(
      "2024-06-15T17:00:00.000Z"
    )
  })

  test("normalizes timestamp strings with positive offsets to UTC", () => {
    expect(normalizeDuckDbTimestampValue("2017-01-02T09:51:02+05:30")).toBe(
      "2017-01-02T04:21:02.000Z"
    )
    expect(normalizeDuckDbTimestampValue("2024-01-01T15:30:00+01:00")).toBe(
      "2024-01-01T14:30:00.000Z"
    )
  })

  test("preserves UTC timestamp strings with Z without modifying them", () => {
    expect(normalizeDuckDbTimestampValue("2017-01-02T17:51:02Z")).toBe("2017-01-02T17:51:02Z")
    expect(normalizeDuckDbTimestampValue("2017-01-02T17:51:02.123Z")).toBe(
      "2017-01-02T17:51:02.123Z"
    )
  })

  test("does not normalize strings with invalid calendar days so DuckDB can refuse them", () => {
    // Feb 29 on non-leap year 2026
    expect(normalizeDuckDbTimestampValue("2026-02-29T10:00:00-08:00")).toBe(
      "2026-02-29T10:00:00-08:00"
    )
    // Non-existent day
    expect(normalizeDuckDbTimestampValue("2026-02-30T10:00:00+02:00")).toBe(
      "2026-02-30T10:00:00+02:00"
    )
  })

  test("normalizes Date instances to ISO UTC strings", () => {
    const date = new Date("2017-01-02T17:51:02.000Z")
    expect(normalizeDuckDbTimestampValue(date)).toBe("2017-01-02T17:51:02.000Z")
  })

  test("returns original string if value does not have a timezone offset", () => {
    expect(normalizeDuckDbTimestampValue("not-a-timestamp")).toBe("not-a-timestamp")
    expect(normalizeDuckDbTimestampValue("9/9/2026")).toBe("9/9/2026")
  })
})
