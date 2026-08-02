import { SixbError, type SixbErrorOptions } from "@sixb/core/errors"

/**
 * The two ways OIDC fails, and they are not the same failure.
 *
 * `runtime.invalid_definition` is the project's own strategy configuration — a missing issuer, a
 * scope without `openid`. Nobody signing in can fix it. `auth.invalid_credentials` is what the
 * provider sent back for one attempt: an id token with no subject, a domain that is not allowed.
 * They answer 500 and 401 respectively, which is why one code for both would be wrong.
 */
export type OidcAuthErrorCode = "runtime.invalid_definition" | "auth.invalid_credentials"

export class OidcAuthError extends SixbError {
  override readonly name = "OidcAuthError"

  constructor(code: OidcAuthErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, `[Sixb] ${message}`, options)
  }
}
