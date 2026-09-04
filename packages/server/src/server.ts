import { cors } from "@elysiajs/cors"
import { openapi } from "@elysiajs/openapi"
import type { OntologyMaintenanceHandle, SixbHostView } from "@sixb/core"
import { CSRF_HEADER_NAME } from "@sixb/core/internal/auth"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { Elysia } from "elysia"
import { websocket as elysiaWebSocket } from "elysia/ws"
import { zodToJsonSchema } from "zod-to-json-schema"
import {
  type AuthInvitationDestinationOptions,
  type AuthInvitationRedirectContext,
  type AuthInvitationRedirectInput,
  BrowserOriginError,
  createApiBrowserAuthContextResolver,
  createApiBrowserAuthRedirectContextResolver,
  getApiBrowserInvitationDestinationOptions,
  isAllowedApiBrowserOrigin,
  type RequestAuthContext,
  type ResolveAuthRedirectContext,
  type ResolvedSixbApiBrowserPolicy,
  type ResolveRequestAuthContext,
  resolveApiBrowserInvitationRedirectContext,
  resolveApiBrowserPolicy,
  resolveApiBrowserPublicOrigin,
  type SixbApiBrowserPolicy,
} from "./auth/browser-origin"
import { CSRF_TOKEN_RESPONSE_HEADER_NAME } from "./auth/csrf"
import type { SixbAuthExperienceOptions } from "./auth/experience"
import { ServerAuthGuard } from "./auth/guard"
import { consumeInternalRequestAuthState } from "./auth/scope"
import { SESSION_ACTIVITY_HEADER_NAME } from "./auth/session-activity"
import { createSessionRenewalCookieHeaders } from "./auth/session-cookies"
import type { LanguageModelDisplayResolver } from "./models-dev/display"
import {
  SIXB_BEARER_SECURITY_SCHEME,
  SIXB_BEARER_SECURITY_SCHEME_ID,
  SIXB_CSRF_SECURITY_SCHEME,
  SIXB_CSRF_SECURITY_SCHEME_ID,
} from "./openapi/security"
import { OPENAPI_TAG_METADATA } from "./openapi/tags"
import { registerHttpRoutes } from "./registerRoutes"
import { registerAuthRoutes } from "./routes/auth"
import { registerWebhookRoutes } from "./routes/webhooks"
import { registerWebSocketRoutes } from "./routes/ws"
import { jsonValueOpenApiOverride } from "./schemas/common"
import { ObjectQueryOpenApiSchemas } from "./schemas/objects"

export interface SixbServerOptions {
  host: SixbHostView
  port?: number
  hostname?: string
  quiet?: boolean
  browser: SixbApiBrowserPolicy
  /** Optional custom-app auth bundle mounted under the API's `/auth` routes. */
  authExperience?: SixbAuthExperienceOptions
}

export function createSixbServer(options: SixbServerOptions): SixbServer {
  return new SixbServer(options)
}

export class SixbServer {
  private readonly hostRuntime: SixbHostView
  private readonly port: number
  private readonly hostname: string
  private readonly quiet: boolean
  private readonly apiBrowserPolicy: ResolvedSixbApiBrowserPolicy
  private readonly authContextResolver: ResolveRequestAuthContext
  private readonly authRedirectContextResolver: ResolveAuthRedirectContext
  private readonly authExperience?: SixbAuthExperienceOptions
  private app: SixbApp | null = null
  private bunServer: ReturnType<typeof Bun.serve> | null = null
  private maintenance: OntologyMaintenanceHandle | null = null

  constructor(options: SixbServerOptions) {
    this.hostRuntime = options.host
    this.port = options.port ?? 3000
    this.hostname = options.hostname ?? "0.0.0.0"
    this.quiet = options.quiet ?? false
    this.apiBrowserPolicy = resolveApiBrowserPolicy(options.browser)
    this.authContextResolver = createApiBrowserAuthContextResolver(this.apiBrowserPolicy)
    this.authRedirectContextResolver = createApiBrowserAuthRedirectContextResolver(
      this.apiBrowserPolicy
    )
    this.authExperience = options.authExperience
  }

  getHost(): SixbHostView {
    return this.hostRuntime
  }

  getPort(): number {
    return this.port
  }

  resolveAuthContext(request: Request): RequestAuthContext {
    return this.authContextResolver(request)
  }

  resolveAuthRedirectContext(
    request: Parameters<ResolveAuthRedirectContext>[0],
    input: Parameters<ResolveAuthRedirectContext>[1]
  ): ReturnType<ResolveAuthRedirectContext> {
    return this.authRedirectContextResolver(request, input)
  }

  resolveAuthRequestOrigin(request: Request): string {
    return resolveApiBrowserPublicOrigin(this.apiBrowserPolicy, request)
  }

  getInvitationDestinationOptions(_request: Request): AuthInvitationDestinationOptions {
    return getApiBrowserInvitationDestinationOptions(this.apiBrowserPolicy)
  }

  resolveInvitationRedirectContext(
    request: Request,
    input: AuthInvitationRedirectInput
  ): AuthInvitationRedirectContext {
    return resolveApiBrowserInvitationRedirectContext(this.apiBrowserPolicy, request, input)
  }

  getApiBrowserPolicy(): ResolvedSixbApiBrowserPolicy {
    return this.apiBrowserPolicy
  }

  getAuthExperience(): SixbAuthExperienceOptions | undefined {
    return this.authExperience
  }

  async start(): Promise<void> {
    if (this.app !== null || this.bunServer !== null || this.maintenance !== null) {
      throw new Error("[SixbServer] Server is already running.")
    }

    const maintenance = await this.hostRuntime.startOntologyMaintenance()
    this.maintenance = maintenance

    try {
      this.app = createSixbApi(this)
      this.bunServer = startApiServer(this.app, {
        host: this.hostname,
        port: this.port,
      })
    } catch (error) {
      this.app = null
      this.bunServer = null
      this.maintenance = null
      await maintenance.stop()
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[SixbServer] Failed to listen on ${this.hostname}:${this.port}: ${message}`)
    }

    if (!this.quiet) {
      const base = `http://${this.hostname}:${this.port}`
      console.log(`Sixb server running at ${base}`)
      console.log(`OpenAPI docs at ${base}/docs`)
    }
  }

  async stop(): Promise<void> {
    if (this.bunServer) {
      this.bunServer.stop(true)
      this.bunServer = null
    }

    if (this.app) {
      await this.app.stop()
      this.app = null
    }

    const maintenance = this.maintenance
    this.maintenance = null
    await maintenance?.stop()
  }
}

export interface CreateSixbApiOptions {
  /** Internal seam for deterministic route tests; production uses the runtime Models.dev cache. */
  readonly modelDisplayResolver?: LanguageModelDisplayResolver
}

export function createSixbApi(server: SixbServer, options: CreateSixbApiOptions = {}) {
  const host = server.getHost()
  const guard = new ServerAuthGuard({
    host,
    resolveAuthContext: (request) => server.resolveAuthContext(request),
  })
  guard.assertCanServeHttp({ production: process.env.NODE_ENV === "production" })
  const apiBrowserPolicy = server.getApiBrowserPolicy()

  const app = new Elysia()

  app.onRequest(({ request }) => {
    const response = rejectDisallowedBrowserOrigin(request, apiBrowserPolicy)
    if (response) {
      return response
    }
  })
  app.use(
    cors({
      origin: (request) => isAllowedApiBrowserOrigin(apiBrowserPolicy, request),
      credentials: true,
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "authorization",
        "content-type",
        CSRF_HEADER_NAME,
        SESSION_ACTIVITY_HEADER_NAME,
      ],
      exposeHeaders: [CSRF_TOKEN_RESPONSE_HEADER_NAME],
      maxAge: 600,
    })
  )

  // Resolve authentication and bind one execution SDK at the request boundary. Protected routes
  // never choose between a principal SDK and the ambient runtime themselves.
  app
    .derive(async ({ request }) => {
      const internalAuthState = consumeInternalRequestAuthState(request)
      if (internalAuthState) {
        const { authorization, ...agentState } = internalAuthState
        return {
          auth: { kind: "allow" as const, session: null },
          ...agentState,
          sixb: bindRequestExecution(host, {
            request,
            authorization,
          }),
        }
      }

      const auth = await guard.resolve(request)
      if (auth.kind === "deny" || !auth.session?.authenticated) {
        return {
          auth,
          sixb:
            auth.kind === "allow" && !guard.isAuthEnabled()
              ? bindRequestExecution(host, {
                  request,
                  authorization: { type: "disabled" },
                })
              : null,
        }
      }

      const authz = host.auth.contextFromSession(auth.session)
      const credential =
        auth.session.credentialSource === "session"
          ? { type: "session" as const, id: auth.session.session.id }
          : { type: "accessToken" as const, id: auth.session.accessToken.id }
      return {
        auth,
        sixb: bindRequestExecution(host, {
          request,
          authorization: { type: "principal", context: authz, credential },
        }),
      }
    })
    .onBeforeHandle(({ auth }) => (auth.kind === "deny" ? auth.response : undefined))
    .mapResponse(({ auth, request, set }) => {
      if (
        !auth ||
        auth.kind !== "allow" ||
        auth.session?.credentialSource !== "session" ||
        auth.session.sessionRenewed !== true
      ) {
        return
      }

      const renewal = createSessionRenewalCookieHeaders({
        host: host,
        request,
        session: auth.session,
      })
      if (!renewal) {
        return
      }

      appendSetCookieHeaders(set, renewal.headers)
      setResponseHeader(set, CSRF_TOKEN_RESPONSE_HEADER_NAME, renewal.csrfToken)
    })

  app.use(
    openapi({
      path: "/docs",
      provider: "swagger-ui",
      documentation: {
        info: {
          title: "Sixb API",
          version: "0.1.0",
          description: "Ontology-first digital twins runtime API",
        },
        components: {
          securitySchemes: {
            [SIXB_CSRF_SECURITY_SCHEME_ID]: SIXB_CSRF_SECURITY_SCHEME,
            [SIXB_BEARER_SECURITY_SCHEME_ID]: SIXB_BEARER_SECURITY_SCHEME,
          },
          schemas: ObjectQueryOpenApiSchemas,
        },
        tags: OPENAPI_TAG_METADATA,
      },
      swagger: {
        withCredentials: true,
      },
      mapJsonSchema: {
        zod: (schema: Parameters<typeof zodToJsonSchema>[0]) =>
          zodToJsonSchema(schema, {
            $refStrategy: "none",
            target: "openApi3",
            override: jsonValueOpenApiOverride,
          }),
      },
    })
  )

  registerAuthRoutes(app, host, {
    resolveAuthContext: (request) => server.resolveAuthContext(request),
    resolveAuthRedirectContext: (request, input) =>
      server.resolveAuthRedirectContext(request, input),
    getInvitationDestinationOptions: (request) => server.getInvitationDestinationOptions(request),
    resolveAuthRequestOrigin: (request) => server.resolveAuthRequestOrigin(request),
    authExperience: server.getAuthExperience(),
    resolveInvitationRedirectContext: (request, input) =>
      server.resolveInvitationRedirectContext(request, input),
  })
  registerHttpRoutes(app, host, {
    connectorConnections: {
      resolveReturnTo: (request, returnTo) => {
        const authContext = server.resolveAuthContext(request)
        return server.resolveAuthRedirectContext(request, {
          audience: authContext.audience,
          returnTo,
        }).returnTo
      },
      resolveCallbackUrl: (request) =>
        new URL("/auth/connectors/callback", server.resolveAuthRequestOrigin(request)).toString(),
    },
    modelDisplayResolver: options.modelDisplayResolver,
  })
  registerWebhookRoutes(app, host)
  registerWebSocketRoutes(app, server)

  return app
}

interface ElysiaSet {
  headers?: unknown
}

function appendSetCookieHeaders(set: ElysiaSet, values: readonly string[]): void {
  if (set.headers instanceof Headers) {
    for (const value of values) set.headers.append("set-cookie", value)
    return
  }

  if (!set.headers || typeof set.headers !== "object" || Array.isArray(set.headers)) {
    set.headers = {}
  }

  const headers = set.headers as Record<string, string | number | string[] | undefined>
  const existing = headers["set-cookie"]
  headers["set-cookie"] = [
    ...(existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)]),
    ...values,
  ]
}

function setResponseHeader(set: ElysiaSet, name: string, value: string): void {
  if (set.headers instanceof Headers) {
    set.headers.set(name, value)
    return
  }

  if (!set.headers || typeof set.headers !== "object" || Array.isArray(set.headers)) {
    set.headers = {}
  }

  const headers = set.headers as Record<string, string | number | string[] | undefined>
  headers[name] = value
}

function rejectDisallowedBrowserOrigin(
  request: Request,
  policy: ResolvedSixbApiBrowserPolicy
): Response | undefined {
  if (!request.headers.has("origin")) {
    return undefined
  }

  try {
    if (isAllowedApiBrowserOrigin(policy, request)) {
      return undefined
    }
  } catch (error) {
    if (!(error instanceof BrowserOriginError)) {
      throw error
    }
  }

  return new Response(JSON.stringify({ error: "Browser origin is not allowed" }), {
    status: 403,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

export type SixbApp = ReturnType<typeof createSixbApi>

function startApiServer(
  app: SixbApp,
  options: {
    readonly host: string
    readonly port: number
  }
) {
  const bunServer = Bun.serve({
    port: options.port,
    hostname: options.host,
    fetch: (request) => app.fetch(request),
    websocket: getElysiaWsHandler(app),
  } as Parameters<typeof Bun.serve>[0])

  attachBunServer(app, bunServer)
  return bunServer
}

function getElysiaWsHandler(app: SixbApp) {
  const cfg = (app as unknown as { config?: { websocket?: Record<string, unknown> } }).config
  return {
    ...elysiaWebSocket,
    ...(cfg?.websocket ?? {}),
  } as Parameters<typeof Bun.serve>[0]["websocket"]
}

function attachBunServer(app: SixbApp, bunServer: ReturnType<typeof Bun.serve>) {
  ;(app as unknown as { server: typeof bunServer }).server = bunServer
}
