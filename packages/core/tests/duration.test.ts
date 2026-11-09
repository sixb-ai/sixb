import { describe, expect, test } from "bun:test"
import { parseDuration } from "../src/shared/duration"

describe("parseDuration", () => {
  test("reads minutes, hours, days, weeks and years", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000)
    expect(parseDuration("12h")).toBe(12 * 60 * 60_000)
    expect(parseDuration(" 7d ")).toBe(7 * 24 * 60 * 60_000)
    expect(parseDuration("4w")).toBe(4 * 7 * 24 * 60 * 60_000)
    expect(parseDuration("1y")).toBe(365 * 24 * 60 * 60_000)
  })

  test("is null for anything else", () => {
    for (const value of ["7 days", "7", "1.5h", "-1d", "10s", ""]) {
      expect(parseDuration(value)).toBeNull()
    }
  })
})
