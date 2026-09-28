export type AuthRuntimeErrorCode =
  | "authentication_required"
  | "auth_storage_missing"
  | "authorization_denied"
  | "invalid_auth_input"
  | "invalid_auth_config"
  | "rate_limited"
  | "production_auth_required"

export class AuthRuntimeError extends Error {
  readonly name = "AuthRuntimeError"

  constructor(
    readonly code: AuthRuntimeErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** Why a strategy refused someone who authenticated. Each is something a person can act on. */
export type SignInRefusalReason =
  | "not_invited"
  | "suspended"
  | "domain_not_allowed"
  | "no_trusted_address"

/**
 * Thrown by a strategy that refuses a sign-in for a known reason. The sign-in page tells the
 * person which reason, naming `email` when there is one; `message` is for the server log.
 */
export class SignInRefusedError extends Error {
  readonly name = "SignInRefusedError"

  constructor(
    readonly reason: SignInRefusalReason,
    message: string,
    readonly email?: string
  ) {
    super(message)
  }
}
