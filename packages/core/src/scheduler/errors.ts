import { type SixbErrorOptions, SixbValidationError } from "../errors"

/**
 * An invalid schedule reached the scheduler — a duplicate id, an expression it cannot plan.
 *
 * There is no separate `SchedulerError` base: it had no thrower and no catcher.
 */
export class SchedulerValidationError extends SixbValidationError {
  override readonly name = "SchedulerValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
