export class ScheduleValidationError extends Error {
  readonly name = "ScheduleValidationError"
}

export class CronValidationError extends Error {
  readonly name = "CronValidationError"
}
