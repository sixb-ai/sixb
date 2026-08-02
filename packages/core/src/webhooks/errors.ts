import { type SixbErrorOptions, SixbValidationError } from "../errors"

export class WebhookValidationError extends SixbValidationError {
  override readonly name = "WebhookValidationError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.invalid_definition", message, options)
  }
}
