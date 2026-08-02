import { type SixbErrorOptions, SixbValidationError } from "../errors"

export class SecurityValidationError extends SixbValidationError {
  override readonly name = "SecurityValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
