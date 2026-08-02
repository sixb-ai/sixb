import { type SixbErrorOptions, SixbValidationError } from "../errors"

export class EditBatchError extends SixbValidationError {
  override readonly name = "EditBatchError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("storage.edit_rejected", message, options)
  }
}
