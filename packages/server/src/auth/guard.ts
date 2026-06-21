import {
  type AuthSessionResult,
  type OntologySource,
  type Sixb,
  verifyDoubleSubmitCsrf,
} from "@sixb/core"
import { BrowserOriginError, type ResolveRequestAuthContext } from "./browser-origin"
import { classifyRoute } from "./public-routes"
import {
  htmlAuthRedirectResponse,
  jsonAuthRequiredResponse,
  jsonCsrfFailedResponse,
  jsonForbiddenResponse,
  websocketAuthFailedResponse,
} from "./responses"

export interface ServerAuthGuardOptions {
  readonly sixb: Sixb<readonly OntologySource[]>
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
  | { readonly kind: "allow"; readonly session: AuthSessionResult | null }

export class ServerAuthGuard {
  private readonly sixb: Sixb<readonly OntologySource[]>
  private readonly resolveAuthContext: ResolveRequestAuthContext

  constructor(options: ServerAuthGuardOptions) {
    this.sixb = options.sixb
    this.resolveAuthContext = options.resolveAuthContext
  }

  isAuthEnabled(): boolean {
    return this.sixb.auth.isEnabled()
  }

  assertCanServeHttp(params: { readonly production: boolean }): void {
    this.sixb.auth.assertCanServeHttp(params)
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

    const session = await this.sixb.auth.getSession(request, {
      audience: authContext.audience,
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

    if (route.csrfProtected && !this.verifyCsrf(request, session)) {
      return { kind: "deny", response: jsonCsrfFailedResponse() }
    }

    return { kind: "allow", session }
  }

  getCsrfCookieName(request: Request): string {
    const audience = this.resolveAuthContext(request).audience
    return this.sixb.auth.getCookieOptions({ audience }).csrfCookieName
  }

  verifyCsrf(
    request: Request,
    _session: Extract<AuthSessionResult, { authenticated: true }>
  ): boolean {
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
