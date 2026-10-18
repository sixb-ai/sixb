import { describe, expect, test } from "bun:test"
import {
  CronValidationError,
  defineSchedule,
  isScheduleDefinition,
  ScheduleValidationError,
} from "../src/schedules"

describe("defineSchedule", () => {
  test.each([
    [
      "an empty id",
      () => defineSchedule(""),
      ScheduleValidationError,
      "Schedule id must not be empty",
    ],
    [
      "a whitespace-only id",
      () => defineSchedule("   "),
      ScheduleValidationError,
      "Schedule id must not be empty",
    ],
    [
      "an empty cron expression",
      () => defineSchedule("s1").cron(""),
      ScheduleValidationError,
      "Schedule cron expression must not be empty",
    ],
    [
      "an invalid cron expression",
      () => defineSchedule("s1").cron("not-a-cron"),
      CronValidationError,
      "Invalid cron expression",
    ],
    [
      "an invalid timezone",
      () => defineSchedule("s1").cron("0 * * * *", { timezone: "Invalid/TZ" }),
      ScheduleValidationError,
      "Invalid timezone 'Invalid/TZ'",
    ],
  ] as const)("rejects %s", (_name, define, ErrorClass, message) => {
    expect(define).toThrow(ErrorClass)
    expect(define).toThrow(message)
  })

  test("builds a cron schedule definition, keeping a timezone only when given", () => {
    const schedule = defineSchedule("nightly-sync").cron("0 0 * * *")

    expect(schedule.kind).toBe("schedule")
    expect(schedule.id).toBe("nightly-sync")
    expect(schedule.trigger).toEqual({ type: "cron", expression: "0 0 * * *" })
    expect("timezone" in schedule.trigger).toBe(false)

    expect(
      defineSchedule("paris-sync").cron("0 0 * * *", { timezone: "Europe/Paris" }).trigger
    ).toEqual({ type: "cron", expression: "0 0 * * *", timezone: "Europe/Paris" })
  })
})

test.each([
  ["a defined schedule", defineSchedule("s1").cron("0 * * * *"), true],
  ["null", null, false],
  ["a wrong kind", { kind: "sync", id: "s1", trigger: { type: "cron" } }, false],
  ["a missing trigger", { kind: "schedule", id: "s1" }, false],
  ["a missing id", { kind: "schedule", trigger: { type: "cron" } }, false],
] as const)("isScheduleDefinition recognizes %s", (_name, value, expected) => {
  expect(isScheduleDefinition(value)).toBe(expected)
})
