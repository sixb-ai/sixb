import { type SixbErrorOptions, SixbValidationError } from "../errors"

export class SyncValidationError extends SixbValidationError {
  override readonly name = "SyncValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
