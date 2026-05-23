import { AuthRuntimeError } from "./errors"

export const DEFAULT_AUTH_SESSION_AUDIENCE = "atlas"
export const AUTH_SESSION_AUDIENCE_PATTERN = /^[a-z][a-z0-9-]{0,47}$/

export type AuthSessionAudience =
  | typeof DEFAULT_AUTH_SESSION_AUDIENCE
  | "sentinel"
  | "app"
  | (string & {})

export interface AuthSessionAudienceOptions {
  readonly audience?: AuthSessionAudience
}

export function isValidAuthSessionAudience(value: string): value is AuthSessionAudience {
  return AUTH_SESSION_AUDIENCE_PATTERN.test(value)
}

export function resolveAuthSessionAudience(
  value: AuthSessionAudience | undefined
): AuthSessionAudience {
  const audience = value ?? DEFAULT_AUTH_SESSION_AUDIENCE

  if (!isValidAuthSessionAudience(audience)) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      `[Sixb] Auth session audience '${audience}' is invalid. Use a lower-case slug matching ${AUTH_SESSION_AUDIENCE_PATTERN.source}.`
    )
  }

  return audience
}
