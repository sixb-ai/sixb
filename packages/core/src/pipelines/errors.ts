import { type SixbErrorOptions, SixbValidationError } from "../errors"

export class PipelineError extends SixbValidationError {
  override readonly name = "PipelineError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
