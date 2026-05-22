export type AuthStorageErrorCode =
  | "duplicate_identity"
  | "duplicate_invitation"
  | "duplicate_magic_link"
  | "duplicate_oidc_attempt"
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
  | "missing_session"
  | "missing_user"
  | "suspended_user"
  | "user_creation_not_allowed"

/**
 * Error for auth storage invariants and invalid auth state transitions.
 */
export class AuthStorageError extends Error {
  readonly name = "AuthStorageError"

  constructor(
    readonly code: AuthStorageErrorCode,
    message: string
  ) {
    super(message)
  }
}
