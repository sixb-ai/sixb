import { SixbError, type SixbErrorOptions } from "@sixb/core/errors"

/** An orchestrator invariant broke. Always `runtime.unexpected`. */
export function orchestratorError(message: string, options?: SixbErrorOptions): SixbError {
  return new SixbError("runtime.unexpected", `[SixbOrchestrator] ${message}`, options)
}
