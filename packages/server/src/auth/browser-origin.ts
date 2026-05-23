import {
  type AuthSessionAudience,
  DEFAULT_AUTH_SESSION_AUDIENCE,
  isValidAuthSessionAudience,
  resolveAuthSessionAudience,
} from "@pario/core"
import { sanitizeReturnTo } from "./return-to"

export interface ParioBrowserOrigin {
  readonly origin: string
  readonly audience: AuthSessionAudience
  readonly kind?: "admin" | "app"
}

export interface ParioApiBrowserPolicy {
  readonly publicOrigin?: string
  readonly allowedOrigins: readonly ParioBrowserOrigin[]
  readonly sameOriginAudience?: AuthSessionAudience
}

export interface ResolvedParioBrowserOrigin {
  readonly origin: string
  readonly audience: AuthSessionAudience
  readonly kind?: "admin" | "app"
}

export interface ResolvedParioApiBrowserPolicy {
  readonly publicOrigin?: string
  readonly sameOriginAudience: AuthSessionAudience
  readonly allowedOrigins: readonly ResolvedParioBrowserOrigin[]
}

export interface RequestAuthContext {
  readonly audience: AuthSessionAudience
  readonly browserOrigin?: string
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

export function resolveBrowserApiPolicy(
  policy: ParioApiBrowserPolicy
): ResolvedParioApiBrowserPolicy {
  const sameOriginAudience = resolveAuthSessionAudience(
    policy.sameOriginAudience ?? DEFAULT_AUTH_SESSION_AUDIENCE
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
    throw new Error("[ParioServer] browserApi requires at least one allowed browser origin.")
  }

  return {
    publicOrigin: policy.publicOrigin
      ? normalizeHttpOrigin(policy.publicOrigin, "browser API public origin")
      : undefined,
    sameOriginAudience,
    allowedOrigins: [...origins.values()],
  }
}

export function createFixedAuthContextResolver(
  audience: AuthSessionAudience
): ResolveRequestAuthContext {
  const resolvedAudience = resolveAuthSessionAudience(audience)
  return () => ({ audience: resolvedAudience })
}

export function createFixedAuthRedirectContextResolver(
  audience: AuthSessionAudience
): ResolveAuthRedirectContext {
  const resolvedAudience = resolveAuthSessionAudience(audience)
  // Temporary compatibility for fixed-audience API/internal tests while the browser flows move to
  // the separated-origin browserApi model. Do not use this for new browser-facing auth routes.
  return (request, input) => ({
    audience: resolvedAudience,
    returnTo: sanitizeReturnTo(input.returnTo),
    requestOrigin: new URL(request.url).origin,
  })
}

export function createBrowserApiAuthContextResolver(
  policy: ResolvedParioApiBrowserPolicy
): ResolveRequestAuthContext {
  return (request) => resolveBrowserApiAuthContext(policy, request)
}

export function createBrowserApiAuthRedirectContextResolver(
  policy: ResolvedParioApiBrowserPolicy
): ResolveAuthRedirectContext {
  return (request, input) => resolveBrowserApiAuthRedirectContext(policy, request, input)
}

export function resolveBrowserApiAuthContext(
  policy: ResolvedParioApiBrowserPolicy,
  request: Request
): RequestAuthContext {
  const origin = normalizeRequestOrigin(request)
  if (!origin) {
    return { audience: policy.sameOriginAudience }
  }

  const allowed = findAllowedBrowserOrigin(policy, origin)
  if (allowed) {
    return { audience: allowed.audience, browserOrigin: allowed.origin }
  }

  if (isSameOriginApiRequest(policy, origin, request)) {
    return { audience: policy.sameOriginAudience, browserOrigin: origin }
  }

  throw new BrowserOriginError(`[ParioServer] Browser origin '${origin}' is not allowed.`)
}

export function isAllowedBrowserApiOrigin(
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

export function resolveBrowserApiAuthRedirectContext(
  policy: ResolvedParioApiBrowserPolicy,
  request: Request,
  input: AuthRedirectInput
): AuthRedirectContext {
  const audience = resolveRequiredAuthAudience(input.audience)
  const returnTo = resolveBrowserApiReturnTo(policy, request, input, audience)

  return {
    audience,
    returnTo,
    requestOrigin: resolveBrowserApiPublicOrigin(policy, request),
  }
}

export function resolveBrowserApiPublicOrigin(
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
  const apiOrigin = resolveBrowserApiPublicOrigin(policy, request)
  return origin === apiOrigin
}

function resolveRequiredAuthAudience(value: string | null | undefined): AuthSessionAudience {
  const audience = value?.trim()
  if (!audience || !isValidAuthSessionAudience(audience)) {
    throw new BrowserOriginError("[ParioServer] Auth audience is invalid or missing.")
  }

  return audience
}

function resolveBrowserApiReturnTo(
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

  if (origin === resolveBrowserApiPublicOrigin(policy, request)) {
    return policy.sameOriginAudience
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
