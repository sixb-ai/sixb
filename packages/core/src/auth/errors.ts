import { SixbError, type SixbErrorCode, type SixbErrorOptions } from "../errors"

const AUTH_RUNTIME_ERROR_REASONS = [
  "authentication_required",
  "auth_storage_missing",
  "authorization_denied",
  "invalid_auth_input",
  "invalid_auth_config",
  "rate_limited",
  "production_auth_required",
] as const

export type AuthRuntimeErrorReason = (typeof AUTH_RUNTIME_ERROR_REASONS)[number]

const CODE_BY_REASON: Record<AuthRuntimeErrorReason, SixbErrorCode> = {
  authentication_required: "auth.authentication_required",
  auth_storage_missing: "runtime.not_configured",
  authorization_denied: "auth.permission_denied",
  invalid_auth_input: "runtime.invalid_input",
  invalid_auth_config: "runtime.invalid_definition",
  rate_limited: "auth.rate_limited",
  production_auth_required: "runtime.not_configured",
}

export function authRuntimeError(
  reason: AuthRuntimeErrorReason,
  message: string,
  options: SixbErrorOptions = {}
): SixbError {
  return new SixbError(CODE_BY_REASON[reason], message, {
    ...options,
    details: { reason, ...options.details },
  })
}
