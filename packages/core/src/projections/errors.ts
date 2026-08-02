import { type SixbErrorOptions, SixbValidationError } from "../errors"

export class ProjectionValidationError extends SixbValidationError {
  override readonly name = "ProjectionValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
