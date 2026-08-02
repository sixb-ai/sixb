import { SixbError, type SixbErrorOptions } from "@sixb/core/errors"

export class ActionWorkerError extends SixbError {
  override readonly name = "ActionWorkerError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("action.failed", `[SixbActionWorker] ${message}`, options)
  }
}
