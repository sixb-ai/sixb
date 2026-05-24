import {
  type AuthSessionAudience,
  DEFAULT_AUTH_SESSION_AUDIENCE,
  isValidAuthSessionAudience,
  resolveAuthSessionAudience,
} from "@pario/core"

export interface ParioBrowserOrigin {
  readonly origin: string
  readonly audience: AuthSessionAudience
  readonly kind?: "atlas" | "sentinel" | "app"
}

export interface ParioApiBrowserPolicy {
  readonly publicOrigin?: string
  readonly allowedOrigins: readonly ParioBrowserOrigin[]
  readonly apiOriginAudience?: AuthSessionAudience
}

export interface ResolvedParioBrowserOrigin {
  readonly origin: string
  readonly audience: AuthSessionAudience
  readonly kind?: "atlas" | "sentinel" | "app"
}

export interface ResolvedParioApiBrowserPolicy {
  readonly publicOrigin?: string
  readonly apiOriginAudience: AuthSessionAudience
  readonly allowedOrigins: readonly ResolvedParioBrowserOrigin[]
}

export interface RequestAuthContext {
  readonly audience: AuthSessionAudience
  readonly browserOrigin?: string
  readonly absoluteReturnTo?: boolean
}

export type ResolveRequestAuthContext = (request: Request) => RequestAuthContext

export interface AuthRedirectInput {
  readonly audience?: string | null
  readonly returnTo?: string | null
  readonly fallbackReturnToOrigin?: string
}

export interface AuthRedirectContext {
  readonly audience: AuthSessionAudience
  readonly returnTo: string
  readonly requestOrigin: string
}

export type ResolveAuthRedirectContext = (
  request: Request,
  input: AuthRedirectInput
) => AuthRedirectContext

export class BrowserOriginError extends Error {
  readonly name = "BrowserOriginError"
}

export function resolveApiBrowserPolicy(
  policy: ParioApiBrowserPolicy
): ResolvedParioApiBrowserPolicy {
  const apiOriginAudience = resolveAuthSessionAudience(
    policy.apiOriginAudience ?? DEFAULT_AUTH_SESSION_AUDIENCE
  )
  const origins = new Map<string, ResolvedParioBrowserOrigin>()

  for (const entry of policy.allowedOrigins) {
    const origin = normalizeHttpOrigin(entry.origin, "browser origin")
    const audience = resolveAuthSessionAudience(entry.audience)
    const existing = origins.get(origin)
    if (existing) {
      if (existing.audience !== audience) {
        throw new Error(
          `[ParioServer] Browser origin '${origin}' is mapped to multiple auth audiences.`
        )
      }
      continue
    }

    origins.set(origin, {
      origin,
      audience,
      kind: entry.kind,
    })
  }

  if (origins.size === 0) {
    throw new Error("[ParioServer] API browser policy requires at least one allowed origin.")
  }

  return {
    publicOrigin: policy.publicOrigin
      ? normalizeHttpOrigin(policy.publicOrigin, "API public origin")
      : undefined,
    apiOriginAudience,
    allowedOrigins: [...origins.values()],
  }
}

export function createApiBrowserAuthContextResolver(
  policy: ResolvedParioApiBrowserPolicy
): ResolveRequestAuthContext {
  return (request) => resolveApiBrowserAuthContext(policy, request)
}

export function createApiBrowserAuthRedirectContextResolver(
  policy: ResolvedParioApiBrowserPolicy
): ResolveAuthRedirectContext {
  return (request, input) => resolveApiBrowserAuthRedirectContext(policy, request, input)
}

export function resolveApiBrowserAuthContext(
  policy: ResolvedParioApiBrowserPolicy,
  request: Request
): RequestAuthContext {
  const origin = normalizeRequestOrigin(request)
  if (!origin) {
    return { audience: policy.apiOriginAudience, absoluteReturnTo: true }
  }

  const allowed = findAllowedBrowserOrigin(policy, origin)
  if (allowed) {
    return { audience: allowed.audience, browserOrigin: allowed.origin, absoluteReturnTo: true }
  }

  if (isSameOriginApiRequest(policy, origin, request)) {
    return { audience: policy.apiOriginAudience, browserOrigin: origin, absoluteReturnTo: true }
  }

  throw new BrowserOriginError(`[ParioServer] Browser origin '${origin}' is not allowed.`)
}

export function isAllowedApiBrowserOrigin(
  policy: ResolvedParioApiBrowserPolicy,
  request: Request
): boolean {
  const origin = normalizeRequestOrigin(request)
  if (!origin) {
    return false
  }

  return (
    findAllowedBrowserOrigin(policy, origin) !== null ||
    isSameOriginApiRequest(policy, origin, request)
  )
}

export function resolveApiBrowserAuthRedirectContext(
  policy: ResolvedParioApiBrowserPolicy,
  request: Request,
  input: AuthRedirectInput
): AuthRedirectContext {
  const audience = resolveRequiredAuthAudience(input.audience)
  const returnTo = resolveApiBrowserReturnTo(policy, request, input, audience)

  return {
    audience,
    returnTo,
    requestOrigin: resolveApiBrowserPublicOrigin(policy, request),
  }
}

export function resolveApiBrowserPublicOrigin(
  policy: ResolvedParioApiBrowserPolicy,
  request: Request
): string {
  return policy.publicOrigin ?? new URL(request.url).origin
}

function findAllowedBrowserOrigin(
  policy: ResolvedParioApiBrowserPolicy,
  origin: string
): ResolvedParioBrowserOrigin | null {
  return policy.allowedOrigins.find((entry) => entry.origin === origin) ?? null
}

function isSameOriginApiRequest(
  policy: ResolvedParioApiBrowserPolicy,
  origin: string,
  request: Request
): boolean {
  const apiOrigin = resolveApiBrowserPublicOrigin(policy, request)
  return origin === apiOrigin
}

function resolveRequiredAuthAudience(value: string | null | undefined): AuthSessionAudience {
  const audience = value?.trim()
  if (!audience || !isValidAuthSessionAudience(audience)) {
    throw new BrowserOriginError("[ParioServer] Auth audience is invalid or missing.")
  }

  return audience
}

function resolveApiBrowserReturnTo(
  policy: ResolvedParioApiBrowserPolicy,
  request: Request,
  input: AuthRedirectInput,
  audience: AuthSessionAudience
): string {
  const rawReturnTo = input.returnTo?.trim()
  const value =
    rawReturnTo ||
    (input.fallbackReturnToOrigin
      ? new URL("/", normalizeHttpOrigin(input.fallbackReturnToOrigin, "fallback return origin"))
          .href
      : "")

  if (!value) {
    throw new BrowserOriginError("[ParioServer] Auth return target is required.")
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BrowserOriginError("[ParioServer] Auth return target must be an absolute URL.")
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new BrowserOriginError("[ParioServer] Auth return target is not allowed.")
  }

  const returnAudience = resolveReturnToAudience(policy, request, url.origin)
  if (returnAudience !== audience) {
    throw new BrowserOriginError("[ParioServer] Auth return target is not allowed.")
  }

  return url.toString()
}

function resolveReturnToAudience(
  policy: ResolvedParioApiBrowserPolicy,
  request: Request,
  origin: string
): AuthSessionAudience | null {
  const allowed = findAllowedBrowserOrigin(policy, origin)
  if (allowed) {
    return allowed.audience
  }

  if (origin === resolveApiBrowserPublicOrigin(policy, request)) {
    return policy.apiOriginAudience
  }

  return null
}

function normalizeRequestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin")
  if (!origin) {
    return null
  }

  try {
    return normalizeHttpOrigin(origin, "Origin header")
  } catch {
    throw new BrowserOriginError("[ParioServer] Origin header is not allowed.")
  }
}

function normalizeHttpOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[ParioServer] Invalid ${label}: '${value}'.`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[ParioServer] ${label} must use http or https.`)
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`[ParioServer] ${label} must be an origin, not a full URL.`)
  }

  return url.origin
}
