import { describe, expect, test } from "bun:test"
import { defineSchedule, isScheduleDefinition } from "../src/schedules"

describe("defineSchedule", () => {
  test("rejects empty ids", () => {
    expect(() => defineSchedule("")).toThrow(
      expect.objectContaining({ code: "runtime.invalid_definition" })
    )
    expect(() => defineSchedule("")).toThrow("Schedule id must not be empty")
  })

  test("rejects whitespace-only ids", () => {
    expect(() => defineSchedule("   ")).toThrow(
      expect.objectContaining({ code: "runtime.invalid_definition" })
    )
    expect(() => defineSchedule("   ")).toThrow("Schedule id must not be empty")
  })

  test("rejects empty cron expressions", () => {
    expect(() => defineSchedule("s1").cron("")).toThrow(
      expect.objectContaining({ code: "runtime.invalid_definition" })
    )
    expect(() => defineSchedule("s1").cron("")).toThrow(
      "Schedule cron expression must not be empty"
    )
  })

  test("rejects invalid cron expressions", () => {
    expect(() => defineSchedule("s1").cron("not-a-cron")).toThrow(
      expect.objectContaining({ code: "runtime.invalid_definition" })
    )
    expect(() => defineSchedule("s1").cron("not-a-cron")).toThrow("Invalid cron expression")
  })

  test("rejects invalid timezones", () => {
    expect(() => defineSchedule("s1").cron("0 * * * *", { timezone: "Invalid/TZ" })).toThrow(
      expect.objectContaining({ code: "runtime.invalid_definition" })
    )
    expect(() => defineSchedule("s1").cron("0 * * * *", { timezone: "Invalid/TZ" })).toThrow(
      "Invalid timezone 'Invalid/TZ'"
    )
  })

  test("builds a cron schedule definition", () => {
    const schedule = defineSchedule("nightly-sync").cron("0 0 * * *")

    expect(schedule.kind).toBe("schedule")
    expect(schedule.id).toBe("nightly-sync")
    expect(schedule.trigger).toEqual({
      type: "cron",
      expression: "0 0 * * *",
    })
  })

  test("preserves timezone when provided", () => {
    const schedule = defineSchedule("paris-sync").cron("0 0 * * *", {
      timezone: "Europe/Paris",
    })

    expect(schedule.trigger).toEqual({
      type: "cron",
      expression: "0 0 * * *",
      timezone: "Europe/Paris",
    })
  })

  test("omits timezone when not provided", () => {
    const schedule = defineSchedule("simple").cron("*/5 * * * *")

    expect(schedule.trigger).toEqual({
      type: "cron",
      expression: "*/5 * * * *",
    })
    expect("timezone" in schedule.trigger).toBe(false)
  })
})

describe("isScheduleDefinition", () => {
  test("returns true for valid schedule", () => {
    const schedule = defineSchedule("s1").cron("0 * * * *")
    expect(isScheduleDefinition(schedule)).toBe(true)
  })

  test("returns false for null", () => {
    expect(isScheduleDefinition(null)).toBe(false)
  })

  test("returns false for wrong kind", () => {
    expect(
      isScheduleDefinition({
        kind: "sync",
        id: "s1",
        trigger: { type: "cron" },
      })
    ).toBe(false)
  })

  test("returns false for missing trigger", () => {
    expect(
      isScheduleDefinition({
        kind: "schedule",
        id: "s1",
      })
    ).toBe(false)
  })

  test("returns false for missing id", () => {
    expect(
      isScheduleDefinition({
        kind: "schedule",
        trigger: { type: "cron" },
      })
    ).toBe(false)
  })
})
