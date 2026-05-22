import { resolveAuthCookieOptions } from "./cookies"
import { AuthRuntimeError } from "./errors"
import type {
  AuthSessionOptions,
  AuthStrategy,
  InvitationDeliveryAuthStrategy,
  MagicLinkAuthStrategy,
  OidcAuthStrategy,
  ParioAuthConfig,
  ResolvedAuthConfig,
} from "./types"

export const DEFAULT_AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_AUTH_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_AUTH_INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export { resolveAuthSessionAudience } from "./audience"

export function resolveAuthConfig(config: ParioAuthConfig | undefined): ResolvedAuthConfig {
  if (!config) {
    return {
      strategy: null,
      session: resolveAuthSessionOptions(undefined),
      cookies: resolveAuthCookieOptions(undefined),
    }
  }

  const strategy = "strategy" in config ? config.strategy : config
  assertValidStrategy(strategy)

  return {
    strategy,
    session: resolveAuthSessionOptions("strategy" in config ? config.session : undefined),
    cookies: resolveAuthCookieOptions("strategy" in config ? config.cookies : undefined),
  }
}

export function resolveInvitationExpiresAt(value: Date | undefined, now: Date): Date {
  const expiresAt = value
    ? new Date(value)
    : new Date(now.getTime() + DEFAULT_AUTH_INVITATION_TTL_MS)
  const expiresAtTime = expiresAt.getTime()

  if (!Number.isFinite(expiresAtTime)) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Pario] Invitation expiresAt must be a valid date."
    )
  }

  if (expiresAtTime <= now.getTime()) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Pario] Invitation expiresAt must be in the future."
    )
  }

  if (expiresAtTime > now.getTime() + MAX_AUTH_INVITATION_TTL_MS) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Pario] Invitation expiresAt must be no more than 30 days in the future."
    )
  }

  return expiresAt
}

export function sanitizeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/"
  }

  try {
    const parsed = new URL(value, "http://pario.local")
    if (parsed.origin !== "http://pario.local") {
      return "/"
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return "/"
  }
}

export function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new AuthRuntimeError("invalid_auth_input", `[Pario] ${label} must be a non-empty string.`)
  }
  return normalized
}

export function normalizePagination(input: { readonly limit?: number; readonly offset?: number }): {
  readonly limit?: number
  readonly offset: number
} {
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 0)) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Pario] Invitation list limit must be a non-negative integer."
    )
  }

  if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Pario] Invitation list offset must be a non-negative integer."
    )
  }

  return {
    limit: input.limit,
    offset: input.offset ?? 0,
  }
}

function resolveAuthSessionOptions(
  options: AuthSessionOptions | undefined
): Required<AuthSessionOptions> {
  const ttlMs = options?.ttlMs ?? DEFAULT_AUTH_SESSION_TTL_MS
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Pario] Auth session ttlMs must be a positive finite number."
    )
  }

  return { ttlMs }
}

export function isMagicLinkAuthStrategy(
  strategy: AuthStrategy | null
): strategy is MagicLinkAuthStrategy {
  if (!strategy || strategy.kind !== "magicLink") {
    return false
  }

  const candidate = strategy as {
    readonly requestMagicLink?: unknown
    readonly completeMagicLinkSignIn?: unknown
  }

  return (
    typeof candidate.requestMagicLink === "function" &&
    typeof candidate.completeMagicLinkSignIn === "function"
  )
}

export function isInvitationDeliveryAuthStrategy(
  strategy: AuthStrategy | null
): strategy is InvitationDeliveryAuthStrategy {
  if (!strategy) {
    return false
  }

  const candidate = strategy as {
    readonly deliverInvitation?: unknown
  }

  return typeof candidate.deliverInvitation === "function"
}

export function isOidcAuthStrategy(strategy: AuthStrategy | null): strategy is OidcAuthStrategy {
  if (!strategy || strategy.kind !== "oidc") {
    return false
  }

  const candidate = strategy as {
    readonly startOidcSignIn?: unknown
    readonly completeOidcSignIn?: unknown
  }

  return (
    typeof candidate.startOidcSignIn === "function" &&
    typeof candidate.completeOidcSignIn === "function"
  )
}

function assertValidStrategy(strategy: AuthStrategy): void {
  if (!strategy.id.trim()) {
    throw new AuthRuntimeError("invalid_auth_config", "[Pario] Auth strategy id is required.")
  }
}
