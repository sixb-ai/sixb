import { AuthRuntimeError } from "./errors"

export const DEFAULT_AUTH_SESSION_AUDIENCE = "atlas"

export type AuthSessionAudience = typeof DEFAULT_AUTH_SESSION_AUDIENCE | "app"

export interface AuthSessionAudienceOptions {
  readonly audience?: AuthSessionAudience
}

export function isValidAuthSessionAudience(value: string): value is AuthSessionAudience {
  return value === "atlas" || value === "app"
}

export function resolveAuthSessionAudience(
  value: AuthSessionAudience | undefined
): AuthSessionAudience {
  const audience = value ?? DEFAULT_AUTH_SESSION_AUDIENCE

  if (!isValidAuthSessionAudience(audience)) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      `[Sixb] Auth session audience '${audience}' is invalid. Expected 'atlas' or 'app'.`
    )
  }

  return audience
}
