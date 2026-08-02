import { SixbError, type SixbErrorOptions } from "@sixb/core/errors"

export class WorkflowWorkerError extends SixbError {
  override readonly name = "WorkflowWorkerError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("workflow.failed", message, options)
  }
}
