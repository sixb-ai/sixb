import { SixbAuthorizationError, type SixbErrorOptions } from "../errors"

/** Thrown when a scoped operation is not covered by the principal's grants. Maps to HTTP 403. */
export class AuthorizationError extends SixbAuthorizationError {
  override readonly name = "AuthorizationError"

  constructor(
    /** Stable key of the missing grant, e.g. `view:object:Contract`. */
    readonly grantKey: string,
    message: string,
    options: SixbErrorOptions = {}
  ) {
    super("auth.permission_denied", message, {
      ...options,
      details: { grantKey, ...options.details },
    })
  }
}
