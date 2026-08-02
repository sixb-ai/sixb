import { type SixbErrorOptions, SixbValidationError } from "../errors"

export class DatasetValidationError extends SixbValidationError {
  override readonly name = "DatasetValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
