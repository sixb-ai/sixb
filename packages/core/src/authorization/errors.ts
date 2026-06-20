/** Thrown when a scoped operation is not covered by the principal's grants. Maps to HTTP 403. */
export class AuthorizationError extends Error {
  readonly name = "AuthorizationError"

  constructor(
    /** Stable key of the missing grant, e.g. `view:object:Contract`. */
    readonly grantKey: string,
    message: string
  ) {
    super(message)
  }
}
