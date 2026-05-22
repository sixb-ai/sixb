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
