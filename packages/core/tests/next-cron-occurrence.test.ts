import { describe, expect, test } from "bun:test"
import { nextCronOccurrence } from "../src/schedules"

describe("nextCronOccurrence", () => {
  test("every minute", () => {
    const result = nextCronOccurrence("* * * * *", new Date("2026-01-01T10:30:00Z"))
    expect(result).toEqual(new Date("2026-01-01T10:31:00Z"))
  })

  test("top of hour", () => {
    const result = nextCronOccurrence("0 * * * *", new Date("2026-01-01T10:30:00Z"))
    expect(result).toEqual(new Date("2026-01-01T11:00:00Z"))
  })

  test("midnight each day", () => {
    const result = nextCronOccurrence("0 0 * * *", new Date("2026-01-15T23:59:00Z"))
    expect(result).toEqual(new Date("2026-01-16T00:00:00Z"))
  })

  test("1st of each month", () => {
    const result = nextCronOccurrence("0 0 1 * *", new Date("2026-03-15T00:00:00Z"))
    expect(result).toEqual(new Date("2026-04-01T00:00:00Z"))
  })

  test("weekday (monday 9am)", () => {
    // 2026-01-07 is a Wednesday
    const result = nextCronOccurrence("0 9 * * 1", new Date("2026-01-07T12:00:00Z"))
    // Next Monday is 2026-01-12
    expect(result).toEqual(new Date("2026-01-12T09:00:00Z"))
  })

  test("step expression */15", () => {
    const result = nextCronOccurrence("*/15 * * * *", new Date("2026-01-01T10:07:00Z"))
    expect(result).toEqual(new Date("2026-01-01T10:15:00Z"))
  })

  test("year boundary", () => {
    const result = nextCronOccurrence("0 0 1 1 *", new Date("2026-06-01T00:00:00Z"))
    expect(result).toEqual(new Date("2027-01-01T00:00:00Z"))
  })

  test("timezone Europe/Paris (summer = CEST, UTC+2)", () => {
    // Midnight Paris in summer (CEST) = 22:00 UTC
    const result = nextCronOccurrence("0 0 * * *", new Date("2026-07-15T21:00:00Z"), "Europe/Paris")
    expect(result).toEqual(new Date("2026-07-15T22:00:00Z"))
  })

  test("timezone America/New_York (EDT = UTC-4)", () => {
    // 8:30 AM EDT = 12:30 UTC
    // After 2026-07-01T10:00:00Z (which is 6:00 AM EDT), next 8:30 AM EDT is same day
    const result = nextCronOccurrence(
      "30 8 * * *",
      new Date("2026-07-01T10:00:00Z"),
      "America/New_York"
    )
    expect(result).toEqual(new Date("2026-07-01T12:30:00Z"))
  })

  test("DST spring-forward skips non-existent hour", () => {
    // US spring forward 2026: March 8, 2:00 AM -> 3:00 AM EST->EDT
    // Expression "30 2 * * *" at 2:30 AM — this hour doesn't exist on March 8
    // After March 7 in EST (UTC-5), 2:30 AM EST = 7:30 UTC
    // On March 8, clocks jump from 2:00 AM to 3:00 AM, so 2:30 AM doesn't exist
    // Next valid 2:30 AM is March 9 in EDT (UTC-4) = 6:30 UTC
    const result = nextCronOccurrence(
      "30 2 * * *",
      new Date("2026-03-08T07:00:00Z"),
      "America/New_York"
    )
    expect(result).toEqual(new Date("2026-03-09T06:30:00Z"))
  })

  test("boundary: exactly on match returns next occurrence", () => {
    const result = nextCronOccurrence("0 0 * * *", new Date("2026-01-15T00:00:00Z"))
    expect(result).toEqual(new Date("2026-01-16T00:00:00Z"))
  })

  test("boundary: mid-second returns next occurrence", () => {
    const result = nextCronOccurrence("0 0 * * *", new Date("2026-01-15T00:00:30Z"))
    expect(result).toEqual(new Date("2026-01-16T00:00:00Z"))
  })
})
