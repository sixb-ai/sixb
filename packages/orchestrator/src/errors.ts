import { SixbError, type SixbErrorOptions } from "@sixb/core/errors"

export class OrchestratorError extends SixbError {
  override readonly name = "OrchestratorError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("runtime.unexpected", `[SixbOrchestrator] ${message}`, options)
  }
}
