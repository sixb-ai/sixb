import {
  type AuthSessionResult,
  type OntologySource,
  type Pario,
  verifyDoubleSubmitCsrf,
} from "@pario/core"
import { classifyRoute } from "./public-routes"
import {
  htmlAuthRedirectResponse,
  jsonAuthRequiredResponse,
  jsonCsrfFailedResponse,
  websocketAuthFailedResponse,
} from "./responses"

export interface ServerAuthGuardOptions {
  readonly pario: Pario<readonly OntologySource[]>
}

export type HtmlRouteHandler = (request: Request) => Response | Promise<Response>

export class ServerAuthGuard {
  private readonly pario: Pario<readonly OntologySource[]>

  constructor(options: ServerAuthGuardOptions) {
    this.pario = options.pario
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

    const session = await this.pario.auth.getSession(request)
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

    const session = await this.pario.auth.getSession(request)
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
    return this.pario.auth.getSession(request)
  }

  verifyCsrf(
    request: Request,
    _session: Extract<AuthSessionResult, { authenticated: true }>
  ): boolean {
    return verifyDoubleSubmitCsrf(request, {
      cookieName: this.pario.auth.getCookieOptions().csrfCookieName,
    })
  }
}
