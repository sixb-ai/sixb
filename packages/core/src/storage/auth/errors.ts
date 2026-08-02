import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../../errors"

export type AuthStorageErrorReason =
  | "duplicate_access_token"
  | "duplicate_identity"
  | "duplicate_invitation"
  | "duplicate_magic_link"
  | "duplicate_oidc_attempt"
  | "duplicate_service_account"
  | "duplicate_session"
  | "duplicate_user"
  | "email_link_not_allowed"
  | "expired_magic_link"
  | "expired_oidc_attempt"
  | "invalid_input"
  | "invalid_magic_link"
  | "invalid_oidc_attempt"
  | "missing_identity"
  | "missing_invitation"
  | "missing_magic_link"
  | "missing_oidc_attempt"
  | "missing_access_token"
  | "missing_service_account"
  | "missing_session"
  | "missing_user"
  | "suspended_service_account"
  | "suspended_user"
  | "user_creation_not_allowed"

/**
 * Twenty-five reasons collapse onto five codes, and the collapse is the point: a caller outside
 * the process needs to know whether to re-authenticate, back off, or give up, not which of four
 * duplicate keys collided. The reason survives in `details` for whoever is reading the run.
 *
 * A credential that is missing, expired, or malformed is deliberately one code — telling an
 * unauthenticated caller which of the three it was is how link and token enumeration works.
 */
const CODE_BY_REASON: Record<AuthStorageErrorReason, SixbErrorCode> = {
  duplicate_access_token: "storage.conflict",
  duplicate_identity: "storage.conflict",
  duplicate_invitation: "storage.conflict",
  duplicate_magic_link: "storage.conflict",
  duplicate_oidc_attempt: "storage.conflict",
  duplicate_service_account: "storage.conflict",
  duplicate_session: "storage.conflict",
  duplicate_user: "storage.conflict",
  email_link_not_allowed: "auth.permission_denied",
  expired_magic_link: "auth.invalid_credentials",
  expired_oidc_attempt: "auth.invalid_credentials",
  invalid_input: "runtime.invalid_input",
  invalid_magic_link: "auth.invalid_credentials",
  invalid_oidc_attempt: "auth.invalid_credentials",
  missing_identity: "auth.invalid_credentials",
  missing_invitation: "auth.record_not_found",
  missing_magic_link: "auth.invalid_credentials",
  missing_oidc_attempt: "auth.invalid_credentials",
  missing_access_token: "auth.record_not_found",
  missing_service_account: "auth.record_not_found",
  missing_session: "auth.session_expired",
  missing_user: "auth.invalid_credentials",
  suspended_service_account: "auth.permission_denied",
  suspended_user: "auth.permission_denied",
  user_creation_not_allowed: "auth.permission_denied",
}

/**
 * Error for auth storage invariants and invalid auth state transitions.
 */
export class AuthStorageError extends SixbError {
  override readonly name = "AuthStorageError"

  constructor(
    readonly reason: AuthStorageErrorReason,
    message: string,
    options: SixbErrorOptions = {}
  ) {
    super(CODE_BY_REASON[reason], message, {
      ...options,
      details: { reason, ...options.details },
    })
  }
}
