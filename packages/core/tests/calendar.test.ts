import { describe, expect, test } from "bun:test"
import {
  addCalendarPeriods,
  calendarPeriodStart,
  calendarPeriods,
  canonicalTimeZone,
  wallClockAt,
  wallClockInstant,
} from "../src/calendar"

const at = (value: string) => new Date(value)
const iso = (value: Date) => value.toISOString()

describe("calendar periods", () => {
  test("start where the zone's clocks do", () => {
    expect(iso(calendarPeriodStart(at("2026-10-30T18:00:00.000Z"), "hour"))).toBe(
      "2026-10-30T18:00:00.000Z"
    )
    expect(iso(calendarPeriodStart(at("2026-10-30T18:00:00.000Z"), "day"))).toBe(
      "2026-10-30T00:00:00.000Z"
    )
    // Weeks begin on Monday: October 30, 2026 is a Friday.
    expect(iso(calendarPeriodStart(at("2026-10-30T18:00:00.000Z"), "week"))).toBe(
      "2026-10-26T00:00:00.000Z"
    )
    // India runs five and a half hours ahead, so its days start at half past a UTC hour.
    expect(iso(calendarPeriodStart(at("2026-10-30T18:00:00.000Z"), "day", "Asia/Kolkata"))).toBe(
      "2026-10-29T18:30:00.000Z"
    )
    // 18:00 UTC is 23:30 in New Delhi, so the hour it falls in began at 17:30 UTC.
    expect(iso(calendarPeriodStart(at("2026-10-30T18:00:00.000Z"), "hour", "Asia/Kolkata"))).toBe(
      "2026-10-30T17:30:00.000Z"
    )
  })

  test("step a day at a time across a change of clocks", () => {
    // New York falls back on November 1, 2026, so that day lasts 25 hours.
    const sunday = calendarPeriodStart(at("2026-11-01T15:00:00.000Z"), "day", "America/New_York")
    expect(iso(sunday)).toBe("2026-11-01T04:00:00.000Z")
    const monday = addCalendarPeriods(sunday, "day", 1, "America/New_York")
    expect(iso(monday)).toBe("2026-11-02T05:00:00.000Z")
    expect((monday.getTime() - sunday.getTime()) / 3_600_000).toBe(25)

    // Springing forward skips 2 am, so 1 am is followed by 3 am, one real hour later.
    const one = at("2026-03-08T06:00:00.000Z")
    expect(iso(one)).toBe("2026-03-08T06:00:00.000Z")
    expect(iso(addCalendarPeriods(one, "hour", 1, "America/New_York"))).toBe(
      "2026-03-08T07:00:00.000Z"
    )
    expect(
      calendarPeriods(one, at("2026-03-08T09:00:00.000Z"), "hour", "America/New_York").map(
        (period) => iso(period.start)
      )
    ).toEqual(["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T08:00:00.000Z"])
  })

  test("start a day whose midnight the zone skips at the jump", () => {
    // Chile moves its clocks from midnight to 1 am on September 6, 2026.
    expect(
      iso(calendarPeriodStart(at("2026-09-06T15:00:00.000Z"), "day", "America/Santiago"))
    ).toBe("2026-09-06T04:00:00.000Z")
  })

  // Removal proof: step from the wall clock of the jump instead of the period's midnight; every
  // day after September 6 starts at 1 am, and no call finds the day it belongs to.
  test("step back onto midnight after a day that began at the jump", () => {
    expect(
      calendarPeriods(
        at("2026-09-05T04:00:00.000Z"),
        at("2026-09-08T03:00:00.000Z"),
        "day",
        "America/Santiago"
      ).map((period) => iso(period.start))
    ).toEqual(["2026-09-05T04:00:00.000Z", "2026-09-06T04:00:00.000Z", "2026-09-07T03:00:00.000Z"])

    // Lord Howe Island moves its clocks half an hour, from 2 am to 2:30, on October 4, 2026.
    expect(
      calendarPeriods(
        at("2026-10-03T14:30:00.000Z"),
        at("2026-10-03T17:30:00.000Z"),
        "hour",
        "Australia/Lord_Howe"
      ).map((period) => iso(period.start))
    ).toEqual([
      "2026-10-03T14:30:00.000Z",
      "2026-10-03T15:30:00.000Z",
      "2026-10-03T16:00:00.000Z",
      "2026-10-03T17:00:00.000Z",
    ])
  })

  test("read a wall clock a database returns without a zone", () => {
    expect(iso(wallClockInstant("2026-11-14T00:00:00Z", "America/New_York"))).toBe(
      "2026-11-14T05:00:00.000Z"
    )
    expect(iso(wallClockInstant("2026-11-14T07:00:00Z", "America/New_York"))).toBe(
      "2026-11-14T12:00:00.000Z"
    )
    expect(() => wallClockInstant("yesterday")).toThrow("is not a wall clock time")
    expect(wallClockAt(at("2026-11-14T05:00:00.000Z"), "America/New_York")).toBe(
      "2026-11-14T00:00:00.000Z"
    )
  })

  test("name a zone canonically, or not at all", () => {
    expect(canonicalTimeZone("europe/paris")).toBe("Europe/Paris")
    expect(canonicalTimeZone("Mars/Olympus")).toBeUndefined()
    expect(canonicalTimeZone("  UTC")).toBeUndefined()
  })
})
