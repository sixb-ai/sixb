import type { SixbHostView } from "@sixb/core"
import {
  generateCsrfToken,
  getCookie,
  serializeCookie,
  shouldUseSecureCookies,
  verifyDoubleSubmitCsrf,
} from "@sixb/core/internal/auth"
import { SharedAccessProtocol, type SharedAccessSessionContext } from "@sixb/core/internal/shares"

export const SHARED_ACCESS_SESSION_COOKIE_NAME = "sixb_shared_session"
export const SHARED_ACCESS_CSRF_COOKIE_NAME = "sixb_shared_csrf"

export class SharedAccessGuard {
  private readonly protocol: SharedAccessProtocol | null

  constructor(host: SixbHostView) {
    this.protocol =
      host.storage.shareGrants && host.storage.shareSessions
        ? new SharedAccessProtocol({
            projectId: host.projectId,
            shareTypes: host.definitions.shares,
            storage: host.storage,
          })
        : null
  }

  exchange(grantId: string, secret: string) {
    return this.protocol?.exchange(grantId, secret) ?? Promise.resolve(null)
  }

  resolve(request: Request, grantId: string) {
    return (
      this.protocol?.resolve(grantId, getCookie(request, SHARED_ACCESS_SESSION_COOKIE_NAME)) ??
      Promise.resolve(null)
    )
  }

  revoke(context: SharedAccessSessionContext) {
    return this.protocol?.revoke(context) ?? Promise.resolve(null)
  }

  verifyCsrf(request: Request): boolean {
    return verifyDoubleSubmitCsrf(request, { cookieName: SHARED_ACCESS_CSRF_COOKIE_NAME })
  }

  hasSessionCookie(request: Request): boolean {
    return getCookie(request, SHARED_ACCESS_SESSION_COOKIE_NAME) !== undefined
  }

  createCsrfToken(): string {
    return generateCsrfToken()
  }

  resolveCsrf(
    request: Request,
    grantId: string,
    expiresAt: Date
  ): { readonly token: string; readonly setCookie?: string } {
    const existing = getCookie(request, SHARED_ACCESS_CSRF_COOKIE_NAME)
    if (existing) return { token: existing }

    const token = generateCsrfToken()
    return {
      token,
      setCookie: serializeSharedCookie({
        request,
        grantId,
        name: SHARED_ACCESS_CSRF_COOKIE_NAME,
        value: token,
        expiresAt,
      }),
    }
  }

  createSessionCookies(input: {
    readonly request: Request
    readonly grantId: string
    readonly sessionValue: string
    readonly csrfToken: string
    readonly expiresAt: Date
  }): readonly string[] {
    return [
      serializeSharedCookie({
        request: input.request,
        grantId: input.grantId,
        name: SHARED_ACCESS_SESSION_COOKIE_NAME,
        value: input.sessionValue,
        expiresAt: input.expiresAt,
        httpOnly: true,
      }),
      serializeSharedCookie({
        request: input.request,
        grantId: input.grantId,
        name: SHARED_ACCESS_CSRF_COOKIE_NAME,
        value: input.csrfToken,
        expiresAt: input.expiresAt,
      }),
    ]
  }

  clearSessionCookies(request: Request, grantId: string): readonly string[] {
    return [
      clearSharedCookie(request, grantId, SHARED_ACCESS_SESSION_COOKIE_NAME, true),
      clearSharedCookie(request, grantId, SHARED_ACCESS_CSRF_COOKIE_NAME, false),
    ]
  }
}

function serializeSharedCookie(input: {
  readonly request: Request
  readonly grantId: string
  readonly name: string
  readonly value: string
  readonly expiresAt: Date
  readonly httpOnly?: boolean
}): string {
  return serializeCookie({
    name: input.name,
    value: input.value,
    path: sharedCookiePath(input.grantId),
    httpOnly: input.httpOnly,
    maxAge: Math.max(0, Math.floor((input.expiresAt.getTime() - Date.now()) / 1000)),
    expires: input.expiresAt,
    secure: useSecureSharedCookies(input.request),
    sameSite: "strict",
  })
}

function clearSharedCookie(
  request: Request,
  grantId: string,
  name: string,
  httpOnly: boolean
): string {
  return serializeCookie({
    name,
    value: "",
    path: sharedCookiePath(grantId),
    httpOnly,
    maxAge: 0,
    expires: new Date(0),
    secure: useSecureSharedCookies(request),
    sameSite: "strict",
  })
}

function sharedCookiePath(grantId: string): string {
  return `/api/shares/${encodeURIComponent(grantId)}`
}

function useSecureSharedCookies(request: Request): boolean {
  return shouldUseSecureCookies(request, {
    sessionCookieName: SHARED_ACCESS_SESSION_COOKIE_NAME,
    csrfCookieName: SHARED_ACCESS_CSRF_COOKIE_NAME,
    secure: "auto",
    sameSite: "strict",
    csrfHttpOnly: false,
  })
}
