import { createHash } from "node:crypto"
import type { SixbHostView } from "@sixb/core"
import {
  CSRF_HEADER_NAME,
  generateCsrfToken,
  getCookie,
  isCsrfExemptMethod,
  verifyDoubleSubmitCsrf,
} from "@sixb/core/internal/auth"
import { matchesPathPattern, normalizeRoutePath, SIXB_API_ROUTES } from "@sixb/core/internal/http"
import { type SharedSessionContext, SharedSessionProtocol } from "@sixb/core/internal/shares"
import { hasForegroundSessionActivity } from "./session-activity"

export const SHARED_ACCESS_GRANT_HEADER_NAME = "x-sixb-share-grant"

const SHARED_SESSION_COOKIE_PREFIX = "sixb_share_session_"
const SHARED_CSRF_COOKIE_PREFIX = "sixb_share_csrf_"
const SHARED_COOKIE_PATH = "/api"
const STORED_IDENTIFIER_MAX_LENGTH = 128

const SHARED_SESSION_ROUTES = SIXB_API_ROUTES.filter((route) => route.sharedSession)

export interface SixbSharedAccessOptions {
  /** Sliding inactivity window, always bounded by the grant's absolute expiration. */
  readonly inactivityTtlMs?: number
}

export interface SharedAccessCookieHeaders {
  readonly setCookies: readonly string[]
  readonly csrfToken: string
}

export interface ResolvedSharedAccess {
  readonly context: SharedSessionContext
  readonly cookies: SharedAccessCookieHeaders
}

export type SharedAccessRequestDecision =
  | { readonly kind: "absent" }
  | { readonly kind: "deny"; readonly response: Response }
  | ({ readonly kind: "allow" } & ResolvedSharedAccess)

export type SharedAccessSignOutResult =
  | { readonly kind: "invalid"; readonly setCookies: readonly string[] }
  | { readonly kind: "csrf" }
  | { readonly kind: "signedOut"; readonly setCookies: readonly string[] }

/**
 * Selects shared authority before ambient browser or bearer authentication.
 *
 * The selector header is deliberately not a credential. It chooses one grant-specific HttpOnly
 * cookie, allowing several shared pages to coexist without ever merging their authority.
 */
export class SharedAccessBoundary {
  private readonly host: SixbHostView
  private readonly options: SixbSharedAccessOptions
  private protocol: SharedSessionProtocol | undefined

  constructor(host: SixbHostView, options: SixbSharedAccessOptions = {}) {
    this.host = host
    this.options = options
  }

  /** Fail closed before route parsing can emit a route-specific validation response. */
  preflightResponse(request: Request): Response | undefined {
    if (isSharedAccessPublicRoute(request)) return
    const selectedGrantId = request.headers.get(SHARED_ACCESS_GRANT_HEADER_NAME)
    if (selectedGrantId === null) return
    if (request.headers.has("authorization") || !isSharedSessionRoute(request)) {
      return sharedAccessForbiddenResponse()
    }
    if (!isStoredIdentifier(selectedGrantId)) return sharedAccessUnauthenticatedResponse()
  }

  async resolveRequest(request: Request): Promise<SharedAccessRequestDecision> {
    if (isSharedAccessPublicRoute(request)) return { kind: "absent" }

    const selectedGrantId = request.headers.get(SHARED_ACCESS_GRANT_HEADER_NAME)
    if (selectedGrantId === null) return { kind: "absent" }

    const preflight = this.preflightResponse(request)
    if (preflight) return { kind: "deny", response: preflight }

    let resolved: ResolvedSharedAccess | null
    try {
      resolved = await this.resolveSession(request, selectedGrantId)
    } catch {
      return { kind: "deny", response: sharedAccessUnavailableResponse() }
    }
    if (!resolved) {
      return { kind: "deny", response: sharedAccessUnauthenticatedResponse() }
    }

    if (
      !isCsrfExemptMethod(request.method) &&
      !verifyDoubleSubmitCsrf(request, {
        cookieName: sharedCookieNames(selectedGrantId).csrf,
        headerName: CSRF_HEADER_NAME,
      })
    ) {
      return { kind: "deny", response: sharedAccessForbiddenResponse() }
    }

    return { kind: "allow", ...resolved }
  }

  async exchange(
    request: Request,
    grantId: string,
    secret: string
  ): Promise<ResolvedSharedAccess | null> {
    if (!isStoredIdentifier(grantId)) return null
    const protocol = this.getProtocol()

    const credential = await protocol.exchange(grantId, secret)
    if (!credential) return null

    const csrfToken = generateCsrfToken()
    return {
      context: credential.context,
      cookies: this.createCookieHeaders({
        request,
        grantId,
        sessionValue: credential.cookieValue,
        csrfToken,
        expiresAt: credential.context.expiresAt,
      }),
    }
  }

  async resolveSession(request: Request, grantId: string): Promise<ResolvedSharedAccess | null> {
    if (!isStoredIdentifier(grantId)) return null
    const protocol = this.getProtocol()

    const names = sharedCookieNames(grantId)
    const sessionValue = getCookie(request, names.session)
    const foreground = hasForegroundSessionActivity(request)
    const context = await protocol.resolve(grantId, sessionValue, {
      activity: foreground ? "foreground" : "background",
    })
    if (!context || !sessionValue) return null

    const existingCsrfToken = getCookie(request, names.csrf)
    const csrfToken = existingCsrfToken ?? generateCsrfToken()
    return {
      context,
      cookies: foreground
        ? this.createCookieHeaders({
            request,
            grantId,
            sessionValue,
            csrfToken,
            expiresAt: context.expiresAt,
          })
        : {
            csrfToken,
            setCookies:
              existingCsrfToken === undefined
                ? [
                    serializeSharedCookie({
                      request,
                      name: names.csrf,
                      value: csrfToken,
                      expiresAt: context.expiresAt,
                      maxAge: cookieMaxAge(context.expiresAt),
                    }),
                  ]
                : [],
          },
    }
  }

  async signOut(request: Request, grantId: string): Promise<SharedAccessSignOutResult> {
    if (!isStoredIdentifier(grantId)) {
      return { kind: "invalid", setCookies: [] }
    }

    const clearCookies = this.clearCookieHeaders(request, grantId)
    const resolved = await this.resolveSession(request, grantId)
    if (!resolved) return { kind: "invalid", setCookies: clearCookies }

    if (
      !verifyDoubleSubmitCsrf(request, {
        cookieName: sharedCookieNames(grantId).csrf,
        headerName: CSRF_HEADER_NAME,
      })
    ) {
      return { kind: "csrf" }
    }

    const protocol = this.getProtocol()
    await protocol.revoke(resolved.context)
    return { kind: "signedOut", setCookies: clearCookies }
  }

  clearCookieHeaders(request: Request, grantId: string): readonly string[] {
    if (!isStoredIdentifier(grantId)) return []
    const names = sharedCookieNames(grantId)
    return [
      serializeSharedCookie({
        request,
        name: names.session,
        value: "",
        expiresAt: new Date(0),
        maxAge: 0,
        httpOnly: true,
      }),
      serializeSharedCookie({
        request,
        name: names.csrf,
        value: "",
        expiresAt: new Date(0),
        maxAge: 0,
      }),
    ]
  }

  private createCookieHeaders(input: {
    readonly request: Request
    readonly grantId: string
    readonly sessionValue: string
    readonly csrfToken: string
    readonly expiresAt: Date
  }): SharedAccessCookieHeaders {
    const names = sharedCookieNames(input.grantId)
    const maxAge = cookieMaxAge(input.expiresAt)
    return {
      csrfToken: input.csrfToken,
      setCookies: [
        serializeSharedCookie({
          request: input.request,
          name: names.session,
          value: input.sessionValue,
          expiresAt: input.expiresAt,
          maxAge,
          httpOnly: true,
        }),
        serializeSharedCookie({
          request: input.request,
          name: names.csrf,
          value: input.csrfToken,
          expiresAt: input.expiresAt,
          maxAge,
        }),
      ],
    }
  }

  private getProtocol(): SharedSessionProtocol {
    if (this.protocol) return this.protocol
    if (!this.host.storage.shareGrants || !this.host.storage.shareSessions) {
      throw new Error("[SixbServer] Shared-access session storage is not configured.")
    }

    this.protocol = new SharedSessionProtocol({
      host: this.host,
      ...(this.options.inactivityTtlMs === undefined
        ? {}
        : { inactivityTtlMs: this.options.inactivityTtlMs }),
    })
    return this.protocol
  }
}

export function isSharedAccessPublicRoute(request: Request): boolean {
  return isSharedAccessPublicPath(new URL(request.url).pathname, request.method)
}

export function isSharedAccessPublicPath(pathname: string, requestMethod: string): boolean {
  const method = requestMethod.toUpperCase()
  const normalizedPathname = normalizeRoutePath(pathname)
  const suffix =
    method === "POST" && normalizedPathname.endsWith("/exchange")
      ? "exchange"
      : method === "GET" && normalizedPathname.endsWith("/session")
        ? "session"
        : method === "POST" && normalizedPathname.endsWith("/sign-out")
          ? "sign-out"
          : null
  if (!suffix) return false
  return matchesPathPattern(normalizedPathname, `/api/shared-access/:grantId/${suffix}`)
}

export function isSharedSessionRoute(request: Request): boolean {
  const method = request.method.toUpperCase()
  const pathname = normalizeRoutePath(new URL(request.url).pathname)
  return SHARED_SESSION_ROUTES.some(
    (route) => route.method === method && matchesPathPattern(pathname, route.path)
  )
}

export function sharedAccessCookieNames(grantId: string): {
  readonly session: string
  readonly csrf: string
} {
  return sharedCookieNames(grantId)
}

export function sharedAccessUnauthenticatedResponse(): Response {
  return sharedBoundaryJsonResponse({ error: "Shared access session is invalid" }, 401)
}

export function sharedAccessForbiddenResponse(): Response {
  return sharedBoundaryJsonResponse({ error: "Shared access is not allowed for this request" }, 403)
}

export function sharedAccessUnavailableResponse(): Response {
  return sharedBoundaryJsonResponse({ error: "Shared access is unavailable" }, 503)
}

export function sharedBoundaryJsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: sharedAccessSecurityHeaders(),
  })
}

export function sharedAccessSecurityHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  })
}

function sharedCookieNames(grantId: string): { readonly session: string; readonly csrf: string } {
  const digest = createHash("sha256").update(grantId).digest("hex")
  return {
    session: `${SHARED_SESSION_COOKIE_PREFIX}${digest}`,
    csrf: `${SHARED_CSRF_COOKIE_PREFIX}${digest}`,
  }
}

function serializeSharedCookie(input: {
  readonly request: Request
  readonly name: string
  readonly value: string
  readonly expiresAt: Date
  readonly maxAge: number
  readonly httpOnly?: boolean
}): string {
  const parts = [
    `${input.name}=${input.value}`,
    `Path=${SHARED_COOKIE_PATH}`,
    "SameSite=Strict",
    `Max-Age=${Math.trunc(input.maxAge)}`,
    `Expires=${input.expiresAt.toUTCString()}`,
  ]
  if (input.httpOnly) parts.push("HttpOnly")
  if (shouldUseSecureSharedCookie(input.request)) parts.push("Secure")
  return parts.join("; ")
}

function cookieMaxAge(expiresAt: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1_000))
}

function shouldUseSecureSharedCookie(request: Request): boolean {
  const url = new URL(request.url)
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
    return false
  }
  return url.protocol === "https:" || process.env.NODE_ENV === "production"
}

function isStoredIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= STORED_IDENTIFIER_MAX_LENGTH &&
    value.trim() === value &&
    !value.includes("\0")
  )
}
