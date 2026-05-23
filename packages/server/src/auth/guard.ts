import {
  type AuthSessionAudience,
  type AuthSessionResult,
  DEFAULT_AUTH_SESSION_AUDIENCE,
  type OntologySource,
  type Pario,
  resolveAuthSessionAudience,
  verifyDoubleSubmitCsrf,
} from "@pario/core"
import {
  BrowserOriginError,
  createFixedAuthContextResolver,
  type ResolveRequestAuthContext,
} from "./browser-origin"
import { classifyRoute } from "./public-routes"
import {
  htmlAuthRedirectResponse,
  jsonAuthRequiredResponse,
  jsonCsrfFailedResponse,
  jsonForbiddenResponse,
  websocketAuthFailedResponse,
} from "./responses"

export interface ServerAuthGuardOptions {
  readonly pario: Pario<readonly OntologySource[]>
  readonly audience?: AuthSessionAudience
  readonly resolveAuthContext?: ResolveRequestAuthContext
}

export type HtmlRouteHandler = (request: Request) => Response | Promise<Response>

export class ServerAuthGuard {
  private readonly pario: Pario<readonly OntologySource[]>
  private readonly resolveAuthContext: ResolveRequestAuthContext
  private readonly staticAudience: AuthSessionAudience

  constructor(options: ServerAuthGuardOptions) {
    this.pario = options.pario
    this.staticAudience = resolveAuthSessionAudience(
      options.audience ?? DEFAULT_AUTH_SESSION_AUDIENCE
    )
    this.resolveAuthContext =
      options.resolveAuthContext ?? createFixedAuthContextResolver(this.staticAudience)
  }

  isAuthEnabled(): boolean {
    return this.pario.auth.isEnabled()
  }

  assertCanServeHttp(params: { readonly production: boolean }): void {
    this.pario.auth.assertCanServeHttp(params)
  }

  async handle(request: Request): Promise<Response | undefined> {
    if (!this.isAuthEnabled()) {
      return undefined
    }

    const route = classifyRoute(request)
    if (route.kind === "public") {
      return undefined
    }

    const authContext = this.tryResolveAuthContext(request)
    if (authContext instanceof Response) {
      return authContext
    }

    const session = await this.pario.auth.getSession(request, {
      audience: authContext.audience,
    })
    if (!session.authenticated) {
      if (route.kind === "html") {
        return htmlAuthRedirectResponse(request)
      }

      if (route.kind === "websocket") {
        return websocketAuthFailedResponse()
      }

      return jsonAuthRequiredResponse()
    }

    if (route.csrfProtected && !this.verifyCsrf(request, session)) {
      return jsonCsrfFailedResponse()
    }

    return undefined
  }

  async requireHtml(request: Request): Promise<Response | undefined> {
    if (!this.isAuthEnabled()) {
      return undefined
    }

    const authContext = this.tryResolveAuthContext(request)
    if (authContext instanceof Response) {
      return authContext
    }

    const session = await this.pario.auth.getSession(request, {
      audience: authContext.audience,
    })
    if (!session.authenticated) {
      return htmlAuthRedirectResponse(request)
    }

    return undefined
  }

  withProtectedHtml(handler: HtmlRouteHandler): HtmlRouteHandler {
    return async (request) => {
      const blocked = await this.requireHtml(request)
      if (blocked) {
        return blocked
      }

      return handler(request)
    }
  }

  async getSession(request: Request): Promise<AuthSessionResult> {
    const authContext = this.resolveAuthContext(request)
    return this.pario.auth.getSession(request, { audience: authContext.audience })
  }

  getCsrfCookieName(request?: Request): string {
    const audience = request ? this.resolveAuthContext(request).audience : this.staticAudience
    return this.pario.auth.getCookieOptions({ audience }).csrfCookieName
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
