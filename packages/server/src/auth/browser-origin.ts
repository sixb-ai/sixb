import {
  type AuthSessionAudience,
  applications,
  DEFAULT_AUTH_SESSION_AUDIENCE,
  isValidAuthSessionAudience,
  resolveAuthSessionAudience,
} from "@sixb/core"

export interface SixbBrowserOrigin {
  readonly origin: string
  readonly audience: AuthSessionAudience
}

export interface SixbApiBrowserPolicy {
  readonly publicOrigin?: string
  readonly allowedOrigins: readonly SixbBrowserOrigin[]
  readonly apiOriginAudience?: AuthSessionAudience
}

export interface ResolvedSixbBrowserOrigin {
  readonly origin: string
  readonly audience: AuthSessionAudience
}

export interface ResolvedSixbApiBrowserPolicy {
  readonly publicOrigin?: string
  readonly apiOriginAudience: AuthSessionAudience
  readonly allowedOrigins: readonly ResolvedSixbBrowserOrigin[]
}

export interface RequestAuthContext {
  readonly audience: AuthSessionAudience
  readonly browserOrigin?: string
  readonly absoluteReturnTo?: boolean
}

export interface AuthInvitationDestination {
  readonly id: AuthSessionAudience
  readonly label: string
}

export interface AuthInvitationDestinationOptions {
  readonly destinations: readonly AuthInvitationDestination[]
  readonly defaultDestinationId?: AuthSessionAudience
}

export interface AuthInvitationRedirectInput {
  readonly destinationId?: AuthSessionAudience
  readonly returnTo?: string
}

export type AuthInvitationRedirectContext = AuthRedirectContext

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
  policy: SixbApiBrowserPolicy
): ResolvedSixbApiBrowserPolicy {
  const apiOriginAudience = resolveAuthSessionAudience(
    policy.apiOriginAudience ?? DEFAULT_AUTH_SESSION_AUDIENCE
  )
  const origins = new Map<string, ResolvedSixbBrowserOrigin>()
  const audienceOrigins = new Map<AuthSessionAudience, string>()

  for (const entry of policy.allowedOrigins) {
    const origin = normalizeHttpOrigin(entry.origin, "browser origin")
    const audience = resolveAuthSessionAudience(entry.audience)
    const existingAudienceOrigin = audienceOrigins.get(audience)
    if (existingAudienceOrigin && existingAudienceOrigin !== origin) {
      throw new Error(
        `[SixbServer] Auth audience '${audience}' is mapped to multiple browser origins.`
      )
    }
    audienceOrigins.set(audience, origin)

    const existing = origins.get(origin)
    if (existing) {
      if (existing.audience !== audience) {
        throw new Error(
          `[SixbServer] Browser origin '${origin}' is mapped to multiple auth audiences.`
        )
      }
      continue
    }

    origins.set(origin, { origin, audience })
  }

  if (origins.size === 0) {
    throw new Error("[SixbServer] API browser policy requires at least one allowed origin.")
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
  policy: ResolvedSixbApiBrowserPolicy
): ResolveRequestAuthContext {
  return (request) => resolveApiBrowserAuthContext(policy, request)
}

export function createApiBrowserAuthRedirectContextResolver(
  policy: ResolvedSixbApiBrowserPolicy
): ResolveAuthRedirectContext {
  return (request, input) => resolveApiBrowserAuthRedirectContext(policy, request, input)
}

export function resolveApiBrowserAuthContext(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request
): RequestAuthContext {
  const origin = normalizeRequestOrigin(request)
  if (!origin) {
    return { audience: policy.apiOriginAudience, absoluteReturnTo: true }
  }

  const allowed = findAllowedBrowserOrigin(policy, origin)
  if (allowed) {
    return {
      audience: allowed.audience,
      browserOrigin: allowed.origin,
      absoluteReturnTo: true,
    }
  }

  if (isSameOriginApiRequest(policy, origin, request)) {
    return { audience: policy.apiOriginAudience, browserOrigin: origin, absoluteReturnTo: true }
  }

  throw new BrowserOriginError(`[SixbServer] Browser origin '${origin}' is not allowed.`)
}

export function isAllowedApiBrowserOrigin(
  policy: ResolvedSixbApiBrowserPolicy,
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
  policy: ResolvedSixbApiBrowserPolicy,
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

export function getApiBrowserInvitationDestinationOptions(
  policy: ResolvedSixbApiBrowserPolicy
): AuthInvitationDestinationOptions {
  const destinations = policy.allowedOrigins.map((entry) => ({
    id: entry.audience,
    label: applications[entry.audience].label,
  }))
  const defaultDestinationId = destinations.some((destination) => destination.id === "app")
    ? applications.app.id
    : destinations.some((destination) => destination.id === "atlas")
      ? applications.atlas.id
      : undefined

  return {
    destinations,
    ...(defaultDestinationId ? { defaultDestinationId } : {}),
  }
}

export function resolveApiBrowserInvitationRedirectContext(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request,
  input: AuthInvitationRedirectInput
): AuthInvitationRedirectContext {
  const authContext = resolveApiBrowserAuthContext(policy, request)
  if (!input.destinationId) {
    return resolveApiBrowserAuthRedirectContext(policy, request, {
      audience: authContext.audience,
      fallbackReturnToOrigin: authContext.browserOrigin,
      returnTo: input.returnTo,
    })
  }

  const destination = policy.allowedOrigins.find((entry) => entry.audience === input.destinationId)
  if (!destination) {
    throw new BrowserOriginError("[SixbServer] Invitation destination is not allowed.")
  }
  assertInvitationReturnToOrigin(input.returnTo, destination.origin)

  return resolveApiBrowserAuthRedirectContext(policy, request, {
    audience: destination.audience,
    fallbackReturnToOrigin: destination.origin,
    returnTo: input.returnTo,
  })
}

export function resolveApiBrowserPublicOrigin(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request
): string {
  return policy.publicOrigin ?? new URL(request.url).origin
}

function findAllowedBrowserOrigin(
  policy: ResolvedSixbApiBrowserPolicy,
  origin: string
): ResolvedSixbBrowserOrigin | null {
  return policy.allowedOrigins.find((entry) => entry.origin === origin) ?? null
}

function isSameOriginApiRequest(
  policy: ResolvedSixbApiBrowserPolicy,
  origin: string,
  request: Request
): boolean {
  const apiOrigin = resolveApiBrowserPublicOrigin(policy, request)
  return origin === apiOrigin
}

function assertInvitationReturnToOrigin(
  returnTo: string | undefined,
  destinationOrigin: string
): void {
  if (!returnTo?.trim()) return

  try {
    if (new URL(returnTo).origin === destinationOrigin) return
  } catch {
    // Fall through to the same public validation error as an origin mismatch.
  }

  throw new BrowserOriginError("[SixbServer] Invitation return target is not allowed.")
}

function resolveRequiredAuthAudience(value: string | null | undefined): AuthSessionAudience {
  const audience = value?.trim()
  if (!audience || !isValidAuthSessionAudience(audience)) {
    throw new BrowserOriginError("[SixbServer] Auth audience is invalid or missing.")
  }

  return audience
}

function resolveApiBrowserReturnTo(
  policy: ResolvedSixbApiBrowserPolicy,
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
    throw new BrowserOriginError("[SixbServer] Auth return target is required.")
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new BrowserOriginError("[SixbServer] Auth return target must be an absolute URL.")
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new BrowserOriginError("[SixbServer] Auth return target is not allowed.")
  }

  const returnAudience = resolveReturnToAudience(policy, request, url.origin)
  if (returnAudience !== audience) {
    throw new BrowserOriginError("[SixbServer] Auth return target is not allowed.")
  }

  return url.toString()
}

function resolveReturnToAudience(
  policy: ResolvedSixbApiBrowserPolicy,
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
    throw new BrowserOriginError("[SixbServer] Origin header is not allowed.")
  }
}

function normalizeHttpOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbServer] Invalid ${label}: '${value}'.`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[SixbServer] ${label} must use http or https.`)
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`[SixbServer] ${label} must be an origin, not a full URL.`)
  }

  return url.origin
}
