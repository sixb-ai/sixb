/**
 * A deterministic input/configuration failure that cannot succeed on queue redelivery.
 *
 * Temporary control-flow bridge: remove this class once Projection has precise non-retryable
 * error codes and its fail/retry policy can branch on those codes instead of `instanceof`.
 */
export class ProjectionWorkerPermanentError extends Error {
  override readonly name = "ProjectionWorkerPermanentError"
}
