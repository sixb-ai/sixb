import { isSixbError, SixbError, type SixbErrorOptions } from "@sixb/core/errors"

/**
 * A projection run failed on something that may well succeed on redelivery, so it carries
 * `retryable: true` against the code's cautious default.
 *
 * The default has to stay cautious: `projection.failed` is also what an unlabeled throw from a
 * projection body is filed as, and that one fails the same way forever. So the override is a hint
 * for an in-process `catch` and nothing more — nothing in the framework branches on it, and nothing
 * should, because a verdict only the live instance carries does not survive a run row or a bundle
 * boundary. Permanence rides on the code instead: {@link isPermanentProjectionWorkerError}.
 */
export function projectionWorkerError(message: string, options: SixbErrorOptions = {}): SixbError {
  return new SixbError("projection.failed", message, { retryable: true, ...options })
}

/**
 * A projection references a dataset column its pinned version does not have, or has under another
 * type. Only an edit to the projection or to the dataset clears it.
 */
export function projectionSchemaMismatch(message: string, options?: SixbErrorOptions): SixbError {
  return new SixbError("projection.schema_mismatch", message, options)
}

/**
 * The queued job no longer matches durable state: its run is already terminal, its projection or
 * dataset is no longer registered, or its pinned identity has moved.
 */
export function projectionJobStale(message: string, options?: SixbErrorOptions): SixbError {
  return new SixbError("projection.job_stale", message, options)
}

/**
 * Whether a projection failure will fail the same way on redelivery.
 *
 * Two codes rather than one boolean. These used to be `projection.failed` with `retryable: false`,
 * and the field was the wrong place for the distinction: `retryable` lives on the thrown class and
 * not in the failure record, so a reader lost it the moment the failure crossed a bundle boundary or
 * came back out of a run row — and `undefined === false` reads as *retryable*, which is the wrong
 * way to fail. The codes also say something to an operator that a boolean could not: fix the
 * projection, or drop a stale job.
 */
export function isPermanentProjectionWorkerError(error: unknown): boolean {
  return (
    isSixbError(error, "projection.schema_mismatch") || isSixbError(error, "projection.job_stale")
  )
}
