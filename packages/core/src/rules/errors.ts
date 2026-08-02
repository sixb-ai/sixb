import { type SixbErrorOptions, SixbValidationError } from "../errors"

/**
 * Invalid rule definitions, at builder time and during runtime startup validation.
 *
 * There is no separate `RuleError` base: it had no thrower and no catcher, so it only ever gave a
 * reader a second name to check.
 */
export class RuleValidationError extends SixbValidationError {
  override readonly name = "RuleValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
