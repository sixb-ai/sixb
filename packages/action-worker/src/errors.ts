import { SixbError, type SixbErrorOptions } from "@sixb/core/errors"

/** An infra-level failure in the action worker. Always `action.failed`. */
export function actionWorkerError(message: string, options?: SixbErrorOptions): SixbError {
  return new SixbError("action.failed", `[SixbActionWorker] ${message}`, options)
}
