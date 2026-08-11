import type { SixbHostRuntime } from "@sixb/core"
import {
  type AuthenticatedRequestAuthSession,
  verifyDoubleSubmitCsrf,
} from "@sixb/core/internal/auth"
import { isAccessTokenRoute, shouldVerifyCsrfForAuthSource } from "./access-token-boundary"
import { sessionCanAccessApplication } from "./application-access"
import { BrowserOriginError, type ResolveRequestAuthContext } from "./browser-origin"
import { classifyRoute } from "./public-routes"
import {
  htmlAuthRedirectResponse,
  jsonAuthRequiredResponse,
  jsonCsrfFailedResponse,
  jsonForbiddenResponse,
  websocketAuthFailedResponse,
} from "./responses"
import { hasForegroundSessionActivity, isSessionTerminationRequest } from "./session-activity"

export interface ServerAuthGuardOptions {
  readonly host: SixbHostRuntime
  readonly resolveAuthContext: ResolveRequestAuthContext
}

/**
 * Per-request authentication decision.
 *
 * `deny` carries the short-circuit response. `allow` carries the resolved
 * session so downstream handlers can use it without resolving it again
 * (null when auth is disabled or the route is public).
 */
export type ServerAuthGuardDecision =
  | { readonly kind: "deny"; readonly response: Response }
  | { readonly kind: "allow"; readonly session: AuthenticatedRequestAuthSession | null }

export class ServerAuthGuard {
  private readonly host: SixbHostRuntime
  private readonly resolveAuthContext: ResolveRequestAuthContext

  constructor(options: ServerAuthGuardOptions) {
    this.host = options.host
    this.resolveAuthContext = options.resolveAuthContext
  }

  isAuthEnabled(): boolean {
    return this.host.auth.isEnabled()
  }

  assertCanServeHttp(params: { readonly production: boolean }): void {
    this.host.auth.assertCanServeHttp(params)
  }

  async resolve(request: Request): Promise<ServerAuthGuardDecision> {
    if (!this.isAuthEnabled()) {
      return { kind: "allow", session: null }
    }

    const route = classifyRoute(request)
    if (route.kind === "public") {
      return { kind: "allow", session: null }
    }

    const authContext = this.tryResolveAuthContext(request)
    if (authContext instanceof Response) {
      return { kind: "deny", response: authContext }
    }

    let session = await this.host.auth.getSession(request, {
      audience: authContext.audience,
      credentialSource: "any",
    })
    if (!session.authenticated) {
      if (route.kind === "html") {
        return {
          kind: "deny",
          response: htmlAuthRedirectResponse(request, {
            absoluteReturnTo: authContext.absoluteReturnTo ?? false,
            audience: authContext.audience,
          }),
        }
      }

      if (route.kind === "websocket") {
        return { kind: "deny", response: websocketAuthFailedResponse() }
      }

      return { kind: "deny", response: jsonAuthRequiredResponse() }
    }

    if (!sessionCanAccessApplication(this.host, session, authContext.audience)) {
      return {
        kind: "deny",
        response: jsonForbiddenResponse("Application access is not allowed"),
      }
    }

    if (session.credentialSource === "accessToken" && !isAccessTokenRoute(request)) {
      return {
        kind: "deny",
        response: jsonForbiddenResponse("Access tokens cannot authenticate this route"),
      }
    }

    if (
      shouldVerifyCsrfForAuthSource(route, session.credentialSource) &&
      !this.verifyCsrf(request, session)
    ) {
      return { kind: "deny", response: jsonCsrfFailedResponse() }
    }

    if (
      session.credentialSource === "session" &&
      route.kind !== "websocket" &&
      !isSessionTerminationRequest(request) &&
      hasForegroundSessionActivity(request)
    ) {
      const activeSession = await this.host.auth.getSession(request, {
        audience: authContext.audience,
        credentialSource: "session",
        sessionActivity: "foreground",
      })
      if (!activeSession.authenticated) {
        if (route.kind === "html") {
          return {
            kind: "deny",
            response: htmlAuthRedirectResponse(request, {
              absoluteReturnTo: authContext.absoluteReturnTo ?? false,
              audience: authContext.audience,
            }),
          }
        }
        return { kind: "deny", response: jsonAuthRequiredResponse() }
      }
      if (!sessionCanAccessApplication(this.host, activeSession, authContext.audience)) {
        return {
          kind: "deny",
          response: jsonForbiddenResponse("Application access is not allowed"),
        }
      }
      session = activeSession
    }

    return { kind: "allow", session }
  }

  getCsrfCookieName(request: Request): string {
    const audience = this.resolveAuthContext(request).audience
    return this.host.auth.getCookieOptions({ audience }).csrfCookieName
  }

  verifyCsrf(request: Request, _session: AuthenticatedRequestAuthSession): boolean {
    return verifyDoubleSubmitCsrf(request, {
      cookieName: this.getCsrfCookieName(request),
    })
  }

  private tryResolveAuthContext(
    request: Request
  ): ReturnType<ResolveRequestAuthContext> | Response {
    try {
      return this.resolveAuthContext(request)
    } catch (error) {
      if (error instanceof BrowserOriginError) {
        return jsonForbiddenResponse("Browser origin is not allowed")
      }

      throw error
    }
  }
}
