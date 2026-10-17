export interface SixbApiBrowserPolicy {
  readonly publicOrigin?: string
  /** The browser origins that may call the API with a session: the project's app. */
  readonly allowedOrigins: readonly string[]
}

export interface ResolvedSixbApiBrowserPolicy {
  readonly publicOrigin?: string
  readonly allowedOrigins: readonly string[]
}

export interface RequestAuthContext {
  readonly browserOrigin?: string
  /**
   * Where a signed-out visitor to one of the API's own pages comes back to: its public origin.
   * Behind a proxy that ends TLS, the request's own URL is `http://` and sign-in refuses it.
   */
  readonly returnToOrigin?: string
}

export interface AuthInvitationRedirectInput {
  readonly returnTo?: string
}

export type AuthInvitationRedirectContext = AuthRedirectContext

export type ResolveRequestAuthContext = (request: Request) => RequestAuthContext

export interface AuthRedirectInput {
  readonly returnTo?: string | null
  readonly fallbackReturnToOrigin?: string
}

export interface AuthRedirectContext {
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
  const allowedOrigins = [
    ...new Set(
      policy.allowedOrigins.map((origin) => normalizeHttpOrigin(origin, "browser origin"))
    ),
  ]

  // Empty is an API serving no browser app: only its own origin is admitted.
  return {
    publicOrigin: policy.publicOrigin
      ? normalizeHttpOrigin(policy.publicOrigin, "API public origin")
      : undefined,
    allowedOrigins,
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
  const returnToOrigin = resolveApiBrowserPublicOrigin(policy, request)
  if (!origin) {
    return { returnToOrigin }
  }

  if (isAllowedOrigin(policy, request, origin)) {
    return { browserOrigin: origin, returnToOrigin }
  }

  throw new BrowserOriginError(`[SixbServer] Browser origin '${origin}' is not allowed.`)
}

/**
 * Whether the request's Origin may call the API with a session. An Origin that is not an http(s)
 * origin, such as a sandboxed frame's `null`, is not allowed, never an error: the CORS plugin asks
 * this of every request, and a throw there replaces the route's response with the error's.
 */
export function isAllowedApiBrowserOrigin(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request
): boolean {
  try {
    const origin = normalizeRequestOrigin(request)
    return origin !== null && isAllowedOrigin(policy, request, origin)
  } catch (error) {
    if (error instanceof BrowserOriginError) return false
    throw error
  }
}

export function resolveApiBrowserAuthRedirectContext(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request,
  input: AuthRedirectInput
): AuthRedirectContext {
  return {
    returnTo: resolveApiBrowserReturnTo(policy, request, input),
    requestOrigin: resolveApiBrowserPublicOrigin(policy, request),
  }
}

/** An invitation lands where the inviter works, or on the app when the request has no Origin. */
export function resolveApiBrowserInvitationRedirectContext(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request,
  input: AuthInvitationRedirectInput
): AuthInvitationRedirectContext {
  const authContext = resolveApiBrowserAuthContext(policy, request)
  return resolveApiBrowserAuthRedirectContext(policy, request, {
    fallbackReturnToOrigin: authContext.browserOrigin ?? policy.allowedOrigins[0],
    returnTo: input.returnTo,
  })
}

export function resolveApiBrowserPublicOrigin(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request
): string {
  return policy.publicOrigin ?? new URL(request.url).origin
}

function isAllowedOrigin(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request,
  origin: string
): boolean {
  return (
    policy.allowedOrigins.includes(origin) ||
    origin === resolveApiBrowserPublicOrigin(policy, request)
  )
}

function resolveApiBrowserReturnTo(
  policy: ResolvedSixbApiBrowserPolicy,
  request: Request,
  input: AuthRedirectInput
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

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    !isAllowedOrigin(policy, request, url.origin)
  ) {
    throw new BrowserOriginError("[SixbServer] Auth return target is not allowed.")
  }

  return url.toString()
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
