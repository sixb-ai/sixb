import { type SixbErrorOptions, SixbValidationError } from "../errors"

export class ScheduleValidationError extends SixbValidationError {
  override readonly name = "ScheduleValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}

export class CronValidationError extends SixbValidationError {
  override readonly name = "CronValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
