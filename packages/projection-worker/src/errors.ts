import { SixbError, type SixbErrorOptions } from "@sixb/core/errors"

/**
 * A projection run failed on something that may well succeed on redelivery, so it carries
 * `retryable: true` against the code's cautious default. `ProjectionWorkerPermanentError` is the
 * case that will not.
 */
export class ProjectionWorkerError extends SixbError {
  override readonly name: string = "ProjectionWorkerError"

  constructor(message: string, options: SixbErrorOptions = {}) {
    super("projection.failed", message, { retryable: true, ...options })
  }
}

/** A deterministic input/configuration failure that cannot succeed on queue redelivery. */
export class ProjectionWorkerPermanentError extends ProjectionWorkerError {
  override readonly name = "ProjectionWorkerPermanentError"

  constructor(message: string, options: SixbErrorOptions = {}) {
    super(message, { ...options, retryable: false })
  }
}
