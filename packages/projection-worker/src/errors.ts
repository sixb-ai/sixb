import { isSixbError, SixbError, type SixbErrorOptions } from "@sixb/core/errors"

/**
 * A projection run failed on something that may well succeed on redelivery, so it carries
 * `retryable: true` against the code's cautious default.
 */
export function projectionWorkerError(message: string, options: SixbErrorOptions = {}): SixbError {
  return new SixbError("projection.failed", message, { retryable: true, ...options })
}

/** A deterministic input/configuration failure that cannot succeed on queue redelivery. */
export function projectionWorkerPermanentError(
  message: string,
  options: SixbErrorOptions = {}
): SixbError {
  return new SixbError("projection.failed", message, { ...options, retryable: false })
}

/**
 * Whether a projection failure will fail the same way on redelivery.
 *
 * `retryable` is the whole distinction — it always was, which is why these used to be a class and a
 * subclass sharing one code. Reading the field says so directly, and it keeps working across a
 * bundle boundary, where `instanceof` would not.
 */
export function isPermanentProjectionWorkerError(error: unknown): boolean {
  return isSixbError(error, "projection.failed") && error.retryable === false
}
