import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../errors"

export interface WorkerAbortErrorOptions extends SixbErrorOptions {
  /** Narrows the failure past the module default; most callers leave this alone. */
  readonly code?: SixbErrorCode
}

/**
 * An operation interrupted by `stop()` or by losing the queue lease.
 *
 * `name` is `"AbortError"` and that is functional, not cosmetic: `isAbortError` routes on it, so the
 * delivery reaches `onAbortError` (release the job for another process) instead of
 * `onExecutionError` (fail it). Assigned through `Error` because `SixbError` declares `name`
 * readonly. Pass `code: "queue.lease_lost"` when the lease is what was lost.
 */
export function workerAbortError(message = "", options: WorkerAbortErrorOptions = {}): SixbError {
  const error = new SixbError(options.code ?? "runtime.cancelled", message, options)
  const abortShaped: Error = error
  abortShaped.name = "AbortError"
  return error
}
