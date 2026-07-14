import { resolveAuthCookieOptions } from "./cookies"
import { AuthRuntimeError } from "./errors"
import type {
  AuthSessionOptions,
  AuthStrategy,
  InvitationDeliveryAuthStrategy,
  MagicLinkAuthStrategy,
  OidcAuthStrategy,
  ResolvedAuthConfig,
  SixbAuthConfig,
} from "./types"

const DAY = 24 * 60 * 60 * 1000

export const DEFAULT_AUTH_SESSION_IDLE_TIMEOUT_MS = 30 * DAY
export const DEFAULT_AUTH_SESSION_RENEWAL_WINDOW_MS = 7 * DAY
export const DEFAULT_AUTH_INVITATION_TTL_MS = 7 * DAY
export const MAX_AUTH_INVITATION_TTL_MS = 30 * DAY
/**
 * Default in-process session cache window. Short enough that a revoked session lingers
 * only briefly, long enough to collapse a burst of requests to a single auth resolution.
 */
export const DEFAULT_AUTH_SESSION_CACHE_TTL_MS = 5_000

export { resolveAuthSessionAudience } from "./audience"

export function resolveAuthConfig(config: SixbAuthConfig | undefined): ResolvedAuthConfig {
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
      "[Sixb] Invitation expiresAt must be a valid date."
    )
  }

  if (expiresAtTime <= now.getTime()) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Sixb] Invitation expiresAt must be in the future."
    )
  }

  if (expiresAtTime > now.getTime() + MAX_AUTH_INVITATION_TTL_MS) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Sixb] Invitation expiresAt must be no more than 30 days in the future."
    )
  }

  return expiresAt
}

export function sanitizeReturnTo(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/"
  }

  try {
    const parsed = new URL(value, "http://sixb.local")
    if (parsed.origin !== "http://sixb.local") {
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
    throw new AuthRuntimeError("invalid_auth_input", `[Sixb] ${label} must be a non-empty string.`)
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
      "[Sixb] Invitation list limit must be a non-negative integer."
    )
  }

  if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) {
    throw new AuthRuntimeError(
      "invalid_auth_input",
      "[Sixb] Invitation list offset must be a non-negative integer."
    )
  }

  return {
    limit: input.limit,
    offset: input.offset ?? 0,
  }
}

function resolveAuthSessionOptions(
  options: AuthSessionOptions | undefined
): ResolvedAuthConfig["session"] {
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_AUTH_SESSION_IDLE_TIMEOUT_MS
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] Auth session idleTimeoutMs must be a positive finite number."
    )
  }

  const renewalWindowMs = options?.renewalWindowMs ?? DEFAULT_AUTH_SESSION_RENEWAL_WINDOW_MS
  if (!Number.isFinite(renewalWindowMs) || renewalWindowMs <= 0) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] Auth session renewalWindowMs must be a positive finite number."
    )
  }
  if (renewalWindowMs >= idleTimeoutMs) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] Auth session renewalWindowMs must be less than idleTimeoutMs."
    )
  }

  const absoluteTimeoutMs = options?.absoluteTimeoutMs
  if (
    absoluteTimeoutMs !== undefined &&
    (!Number.isFinite(absoluteTimeoutMs) || absoluteTimeoutMs <= 0)
  ) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] Auth session absoluteTimeoutMs must be a positive finite number when configured."
    )
  }
  if (absoluteTimeoutMs !== undefined && absoluteTimeoutMs < idleTimeoutMs) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] Auth session absoluteTimeoutMs must be greater than or equal to idleTimeoutMs."
    )
  }

  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_AUTH_SESSION_CACHE_TTL_MS
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] Auth session cacheTtlMs must be a non-negative finite number."
    )
  }
  if (cacheTtlMs >= renewalWindowMs) {
    throw new AuthRuntimeError(
      "invalid_auth_config",
      "[Sixb] Auth session cacheTtlMs must be less than renewalWindowMs."
    )
  }

  return {
    idleTimeoutMs,
    renewalWindowMs,
    ...(absoluteTimeoutMs === undefined ? {} : { absoluteTimeoutMs }),
    cacheTtlMs,
  }
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
    throw new AuthRuntimeError("invalid_auth_config", "[Sixb] Auth strategy id is required.")
  }
}
