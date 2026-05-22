import { createCronMatcher } from "./cron"
import { ScheduleValidationError } from "./errors"
import type { ScheduleBuilder, ScheduleDefinition } from "./types"

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new ScheduleValidationError(`Schedule ${field} must not be empty.`)
  }
}

function validateTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone })
  } catch {
    throw new ScheduleValidationError(`Invalid timezone '${timezone}'.`)
  }
}

/**
 * Define a standalone, reusable schedule.
 *
 * A schedule is a declarative, time-based trigger definition. It defines _when_
 * something should be triggered without encoding _what_ should run.
 *
 * V1 supports cron expressions only.
 *
 * @example
 * ```ts
 * const nightly = defineSchedule("nightly-sync").cron("0 0 * * *", {
 *   timezone: "Europe/Paris",
 * })
 * ```
 */
export function defineSchedule(id: string): ScheduleBuilder {
  assertNonEmpty(id, "id")

  return {
    cron(expression, options): ScheduleDefinition {
      assertNonEmpty(expression, "cron expression")
      createCronMatcher(expression) // validates or throws CronValidationError

      if (options?.timezone !== undefined) {
        validateTimezone(options.timezone)
      }

      return {
        kind: "schedule",
        id,
        trigger: {
          type: "cron",
          expression,
          ...(options?.timezone !== undefined ? { timezone: options.timezone } : {}),
        },
      }
    },
  }
}
