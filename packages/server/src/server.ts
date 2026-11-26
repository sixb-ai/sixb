import { cors } from "@elysiajs/cors"
import { openapi } from "@elysiajs/openapi"
import {
  type OntologyMaintenanceHandle,
  resolveAuthorizationContext,
  type SixbHostView,
} from "@sixb/core"
import { MAX_FILE_UPLOAD_BYTES } from "@sixb/core/blob-storage"
import { ACTION_RUN_DRAIN_TIMEOUT_MS } from "@sixb/core/internal/actions"
import { bindAgentRunRequestExecution } from "@sixb/core/internal/agent-execution"
import { ARTIFACT_FRAME_ROUTE_PREFIX } from "@sixb/core/internal/artifacts/frames"
import { CSRF_HEADER_NAME, setRequestClientAddress } from "@sixb/core/internal/auth"
import {
  authorizeBranchCredential,
  BRANCH_CREDENTIAL_PREFIX,
  branchRuntimeOf,
  isBranchCredentialRoute,
  isBranchSliceRelease,
} from "@sixb/core/internal/branches"
import { bindRequestExecution } from "@sixb/core/internal/request-execution"
import { findDatasetIngestRuntime, setApiPublicOrigin } from "@sixb/core/internal/runtime"
import { checkPipelineMarkings, warmAppliedMarkings } from "@sixb/core/internal/security"
import type { Server, ServerWebSocket } from "bun"
import { Elysia, ParseError } from "elysia"
import { websocket as elysiaWebSocket } from "elysia/ws"
import {
  type AuthInvitationRedirectContext,
  type AuthInvitationRedirectInput,
  createApiBrowserAuthContextResolver,
  createApiBrowserAuthRedirectContextResolver,
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
import {
  type ClientAddressResolver,
  createClientAddressResolver,
  PRIVATE_NETWORKS,
} from "./auth/client-address"
import { CSRF_TOKEN_RESPONSE_HEADER_NAME } from "./auth/csrf"
import type { SixbAuthExperienceOptions } from "./auth/experience"
import { ServerAuthGuard } from "./auth/guard"
import { jsonAuthRequiredResponse, jsonForbiddenResponse } from "./auth/responses"
import { type RunTokenDecision, requestRunToken, resolveRunTokenRequest } from "./auth/run-token"
import { SESSION_ACTIVITY_HEADER_NAME } from "./auth/session-activity"
import { createSessionRenewalCookieHeaders } from "./auth/session-cookies"
import {
  SHARED_ACCESS_GRANT_HEADER_NAME,
  SharedAccessBoundary,
  type SixbSharedAccessOptions,
} from "./auth/shared-access"
import { NamedOpenApiSchemas, openApiJsonSchema } from "./openapi/components"
import {
  SIXB_ACCESS_TOKEN_SECURITY_SCHEME,
  SIXB_ACCESS_TOKEN_SECURITY_SCHEME_ID,
  SIXB_CSRF_SECURITY_SCHEME,
  SIXB_CSRF_SECURITY_SCHEME_ID,
  SIXB_SESSION_SECURITY_REQUIREMENT,
  SIXB_SESSION_SECURITY_SCHEME,
  SIXB_SESSION_SECURITY_SCHEME_ID,
  SIXB_SHARED_GRANT_SECURITY_SCHEME,
  SIXB_SHARED_GRANT_SECURITY_SCHEME_ID,
} from "./openapi/security"
import { OPENAPI_TAG_METADATA } from "./openapi/tags"
import { registerHttpRoutes } from "./registerRoutes"
import { agentRunSessionHandler, startLapsedRunSweeper } from "./routes/agent-runners"
import { registerAuthRoutes } from "./routes/auth"
import { registerWebhookRoutes } from "./routes/webhooks"
import { registerWebSocketRoutes } from "./routes/ws"
import { ObjectQueryOpenApiSchemas } from "./schemas/objects"
import {
  declaredBodyTooLarge,
  limitRequestBody,
  RequestBodyTooLargeError,
} from "./utils/request-body"
import {
  markRequestAuthorized,
  type SixbRequestTimingOptions,
  timeRequest,
} from "./utils/request-timing"

// Clients send only subscription messages; Bun's default would buffer up to 16 MB for one.
export const MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024
/** RFC 6455 Service Restart: tells clients to hand off immediately to the new release. */
const SERVICE_RESTART_CLOSE_CODE = 1012

export interface SixbServerOptions {
  host: SixbHostView
  port?: number
  hostname?: string
  quiet?: boolean
  browser: SixbApiBrowserPolicy
  /** Optional custom-app auth bundle mounted under the API's `/auth` routes. */
  authExperience?: SixbAuthExperienceOptions
  /** Optional server limits for short-lived shared-access sessions. */
  sharedAccess?: SixbSharedAccessOptions
  /**
   * Proxies whose `x-forwarded-for` entries identify the client: IP addresses, CIDR ranges, or
   * `"private"` for loopback, private, and link-local networks. Defaults to `["private"]`.
   */
  trustedProxies?: readonly string[]
  /** Where requests spend their time: a `Server-Timing` header and a log of slow requests. */
  timing?: SixbRequestTimingOptions
  /**
   * Whether this server delivers the events a commit left undelivered and purges expired records,
   * every minute. Defaults to true; set it to false when an orchestrator runs for the project.
   */
  ontologyMaintenance?: boolean
  /**
   * Whether `sixb.datasets.ingest` in this server writes what it stored before it returns, as no
   * worker will. Defaults to true; set it to false when a lake worker runs for the project.
   */
  ingestFlush?: boolean
}

export interface SixbServerStopOptions {
  /**
   * How long in-flight HTTP requests may take to finish before remaining connections are closed.
   * Defaults to 65 seconds, matching the Action drain window; `0` closes them at once. A stop
   * called while another one drains joins it, and a shorter timeout brings its deadline closer.
   */
  readonly timeoutMs?: number
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
  private readonly sharedAccessOptions: SixbSharedAccessOptions
  private readonly resolveClientAddress: ClientAddressResolver
  private readonly timing: SixbRequestTimingOptions
  private app: SixbApp | null = null
  private bunServer: ReturnType<typeof Bun.serve> | null = null
  private closeWebSockets: (() => void) | null = null
  private stopping = false
  private readonly hostsOntologyMaintenance: boolean
  private readonly flushesIngestion: boolean
  private maintenance: OntologyMaintenanceHandle | null = null
  private stopSweeper: (() => void) | null = null
  private inProgressStop: InProgressStop | null = null

  constructor(options: SixbServerOptions) {
    this.hostRuntime = options.host
    this.port = options.port ?? 3000
    this.hostname = options.hostname ?? "0.0.0.0"
    this.quiet = options.quiet ?? false
    this.timing = options.timing ?? {}
    this.hostsOntologyMaintenance = options.ontologyMaintenance ?? true
    this.flushesIngestion = options.ingestFlush ?? true
    this.apiBrowserPolicy = resolveApiBrowserPolicy(options.browser)
    // URLs the API hands to third parties, such as file download URLs, name this origin.
    if (this.apiBrowserPolicy.publicOrigin) {
      setApiPublicOrigin(this.hostRuntime, this.apiBrowserPolicy.publicOrigin)
    }
    this.authContextResolver = createApiBrowserAuthContextResolver(this.apiBrowserPolicy)
    this.authRedirectContextResolver = createApiBrowserAuthRedirectContextResolver(
      this.apiBrowserPolicy
    )
    this.authExperience = options.authExperience
    this.sharedAccessOptions = options.sharedAccess ?? {}
    this.resolveClientAddress = createClientAddressResolver(
      options.trustedProxies ?? [PRIVATE_NETWORKS]
    )
  }

  getHost(): SixbHostView {
    return this.hostRuntime
  }

  /** The port the server listens on once started, so `port: 0` reports the one it bound. */
  getPort(): number {
    return this.bunServer?.port ?? this.port
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

  getSharedAccessOptions(): SixbSharedAccessOptions {
    return this.sharedAccessOptions
  }

  /** Marks the server as stopping so `/ready` answers `503` before connections close. */
  markStopping(): void {
    this.stopping = true
  }

  isStopping(): boolean {
    return this.stopping
  }

  async start(): Promise<void> {
    if (this.app !== null || this.bunServer !== null || this.maintenance !== null) {
      throw new Error("[SixbServer] Server is already running.")
    }
    this.stopping = false

    // Startup cannot see through SQL steps: check what they derive before serving any request.
    await checkPipelineMarkings({
      definitions: this.hostRuntime.definitions,
      lakeStorage: this.hostRuntime.lakeStorage,
    })

    // Objects keep the markings of the versions they were projected from. The first read that
    // needs them waits for them; reading them now spares that read the wait.
    warmAppliedMarkings(this.hostRuntime)

    this.hostRuntime.prepareReadiness()
    this.setIngestFlush(this.flushesIngestion)

    const maintenance = this.hostsOntologyMaintenance
      ? await this.hostRuntime.startOntologyMaintenance()
      : null
    this.maintenance = maintenance

    try {
      this.app = createSixbApi(this)
      const started = startApiServer(this.app, {
        host: this.hostname,
        port: this.port,
        resolveClientAddress: this.resolveClientAddress,
        timing: this.timing,
      })
      this.bunServer = started.bunServer
      this.closeWebSockets = started.closeWebSockets
    } catch (error) {
      this.app = null
      this.bunServer = null
      this.closeWebSockets = null
      this.maintenance = null
      await maintenance?.stop()
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[SixbServer] Failed to listen on ${this.hostname}:${this.port}: ${message}`)
    }

    // A runner on a computer has no worker behind it: the API ends the runs it stops renewing.
    this.stopSweeper = startLapsedRunSweeper(this.hostRuntime)

    if (!this.quiet) {
      const base = `http://${this.hostname}:${this.getPort()}`
      console.log(`Sixb server running at ${base}`)
      console.log(`OpenAPI docs at ${base}/docs`)
    }
  }

  private setIngestFlush(inline: boolean): void {
    const ingest = findDatasetIngestRuntime(this.hostRuntime)
    if (ingest) ingest.writesInline = inline
  }

  async stop(options: SixbServerStopOptions = {}): Promise<void> {
    const timeoutMs = resolveStopTimeoutMs(options.timeoutMs, ACTION_RUN_DRAIN_TIMEOUT_MS)

    // A stop that arrives while another one drains joins it, and can only bring its deadline
    // closer: `sixb api` passes `timeoutMs: 0` when SIGINT follows SIGTERM.
    if (this.inProgressStop) {
      this.inProgressStop.deadline.bringForward(timeoutMs)
      return this.inProgressStop.done
    }

    const deadline = new StopDeadline(timeoutMs)
    const done = this.stopUntil(deadline).finally(() => {
      this.inProgressStop = null
    })
    this.inProgressStop = { deadline, done }
    return done
  }

  private async stopUntil(deadline: StopDeadline): Promise<void> {
    this.stopping = true
    this.setIngestFlush(false)
    this.stopSweeper?.()
    this.stopSweeper = null

    const bunServer = this.bunServer
    const closeWebSockets = this.closeWebSockets
    const app = this.app
    this.bunServer = null
    this.closeWebSockets = null
    this.app = null

    const stopAppAndSockets = async () => {
      try {
        if (app) await stopElysiaHooks(app)
      } finally {
        closeWebSockets?.()
      }
    }

    if (bunServer) {
      await drainBunServer(bunServer, deadline, stopAppAndSockets)
    } else {
      await stopAppAndSockets()
    }

    const maintenance = this.maintenance
    this.maintenance = null
    await maintenance?.stop()
  }
}

export function createSixbApi(server: SixbServer) {
  const host = server.getHost()
  const guard = new ServerAuthGuard({
    host,
    resolveAuthContext: (request) => server.resolveAuthContext(request),
  })
  const sharedAccess = new SharedAccessBoundary(host, server.getSharedAccessOptions())
  const preparedSharedAccess = new WeakMap<
    Request,
    Awaited<ReturnType<SharedAccessBoundary["resolveRequest"]>>
  >()
  const preparedRunToken = new WeakMap<Request, RunTokenDecision>()
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
        SHARED_ACCESS_GRANT_HEADER_NAME,
      ],
      exposeHeaders: [CSRF_TOKEN_RESPONSE_HEADER_NAME],
      maxAge: 600,
    })
  )
  // A runner's session requests, before anything parses them: a runner token speaks only there.
  const serveRunnerSession = agentRunSessionHandler(host)
  app.onRequest(
    async ({ request, server }) => (await serveRunnerSession(request, server)) ?? undefined
  )
  app.onRequest(async ({ request }) => {
    // An Agent's commands, as their run: decided before Elysia parses the body, which the approval
    // gate reads from a copy. No session, share or cookie speaks for such a request.
    const runToken = requestRunToken(request)
    if (runToken === undefined) return undefined
    const decision = await resolveRunTokenRequest({ host, request, token: runToken })
    preparedRunToken.set(request, decision)
    return decision.kind === "deny" ? decision.response : undefined
  })
  app.onRequest(async ({ request, set }) => {
    if (preparedRunToken.has(request)) return undefined
    // Resolve Share intent before Elysia parses route inputs. Otherwise an unsupported route or an
    // invalid shared session could escape through a route-specific 4xx before this boundary ran.
    // CORS is registered first so allowed app origins can read these generic boundary responses.
    const shared = await sharedAccess.resolveRequest(request)
    preparedSharedAccess.set(request, shared)
    if (shared.kind === "allow") {
      // Route parsing happens after onRequest but before derive. Set this here so parse/schema
      // failures from an authenticated shared request cannot become cacheable.
      setResponseHeader(set, "cache-control", "no-store")
    }
    return shared.kind === "deny" ? shared.response : undefined
  })
  // A body over its limit fails while Elysia parses it, before the auth guard or handler runs.
  app.onError(({ error, set }) => {
    if (error instanceof ParseError && error.cause instanceof RequestBodyTooLargeError) {
      set.status = 413
      return { error: error.cause.message }
    }
  })

  // Resolve authentication and bind one execution SDK at the request boundary. Protected routes
  // never choose between a principal SDK and the ambient runtime themselves.
  app
    .derive(async ({ request }) => {
      const runToken = preparedRunToken.get(request)
      preparedRunToken.delete(request)
      if (runToken?.kind === "allow") {
        const { runExecution, ...agentState } = runToken.state
        return {
          auth: { kind: "allow" as const, session: null },
          sharedAccessCookies: null,
          sharedSession: null,
          ...agentState,
          sixb: bindAgentRunRequestExecution(host, { signal: request.signal, ...runExecution }),
        }
      }

      const shared =
        preparedSharedAccess.get(request) ?? (await sharedAccess.resolveRequest(request))
      preparedSharedAccess.delete(request)
      if (shared.kind === "deny") {
        return {
          auth: { kind: "deny" as const, response: shared.response },
          sharedAccessCookies: null,
          sharedSession: null,
          sixb: null,
        }
      }
      if (shared.kind === "allow") {
        return {
          auth: { kind: "allow" as const, session: null },
          sharedAccessCookies: shared.cookies,
          // A socket keeps the session it opened under, to check it still holds.
          sharedSession: shared.context,
          sixb: bindRequestExecution(host, {
            request,
            authorization: {
              type: "delegated",
              access: shared.context.access,
              delegation: {
                kind: "share",
                grantId: shared.context.grantId,
                sessionId: shared.context.sessionId,
              },
            },
          }),
        }
      }

      // A branch's credential reads production as its person, for the branch alone: the files of
      // its objects and its lake slice. Any other route refuses it.
      const branchCredential = bearerOf(request)
      if (branchCredential?.startsWith(BRANCH_CREDENTIAL_PREFIX)) {
        const denied = (response: Response) => ({
          auth: { kind: "deny" as const, response },
          sharedAccessCookies: null,
          sharedSession: null,
          sixb: null,
        })
        const pathname = new URL(request.url).pathname
        if (!isBranchCredentialRoute(request.method, pathname)) {
          return denied(
            jsonForbiddenResponse(
              "A branch credential reads only its objects' files and its lake slice"
            )
          )
        }
        // Releasing its slice reads nothing: the route checks the credential owns it.
        if (isBranchSliceRelease(request.method, pathname)) {
          return {
            auth: { kind: "allow" as const, session: null },
            sharedAccessCookies: null,
            sharedSession: null,
            sixb: null,
          }
        }
        const authorized = await authorizeBranchCredential(host, branchCredential)
        if (!authorized) return denied(jsonAuthRequiredResponse())
        return {
          auth: { kind: "allow" as const, session: null },
          sharedAccessCookies: null,
          sharedSession: null,
          sixb: bindRequestExecution(host, {
            request,
            authorization: { type: "principal", context: authorized.person },
          }),
        }
      }

      // A branch from production runs every local request as the person who copied it: its data
      // is theirs to read, and nobody else signs in to it.
      const branchPerson = await branchPersonContext(host)
      if (branchPerson) {
        // Unauthenticated as it is, a branch answers this machine only: a page elsewhere that
        // resolves its own name to 127.0.0.1 is refused by the name it asks for.
        if (!isLoopbackHost(request)) {
          return {
            auth: {
              kind: "deny" as const,
              response: jsonForbiddenResponse("A branch answers this machine only"),
            },
            sharedAccessCookies: null,
            sharedSession: null,
            sixb: null,
          }
        }
        return {
          auth: { kind: "allow" as const, session: null },
          sharedAccessCookies: null,
          sharedSession: null,
          sixb: bindRequestExecution(host, {
            request,
            authorization: { type: "principal", context: branchPerson },
          }),
        }
      }

      const auth = await guard.resolve(request)
      if (auth.kind === "deny" || !auth.session?.authenticated) {
        return {
          auth,
          sharedAccessCookies: null,
          sharedSession: null,
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
        sharedAccessCookies: null,
        sharedSession: null,
        sixb: bindRequestExecution(host, {
          request,
          authorization: { type: "principal", context: authz, credential },
        }),
      }
    })
    .onBeforeHandle(({ auth, route }) => {
      // A share or an Agent's run token speaks for someone who has not signed in here.
      const signedIn = auth.kind === "allow" && auth.session?.authenticated === true
      markRequestAuthorized(route, signedIn || (auth.kind === "allow" && !guard.isAuthEnabled()))
      return auth.kind === "deny" ? auth.response : undefined
    })
    .mapResponse(({ auth, request, responseValue, set, sharedAccessCookies }) => {
      if (sharedAccessCookies) {
        if (sharedAccessCookies.setCookies.length > 0) {
          appendSetCookieHeaders(set, sharedAccessCookies.setCookies)
        }
        setResponseHeader(set, CSRF_TOKEN_RESPONSE_HEADER_NAME, sharedAccessCookies.csrfToken)
        setResponseHeader(set, "cache-control", "no-store")

        // Elysia intentionally gives headers from an explicit Response precedence over `set`.
        // File reads carry their normal long-lived private cache policy on such a Response, so
        // rebuild it with `no-store` at the same boundary that selected the Share authority.
        if (responseValue instanceof Response) {
          const headers = new Headers(responseValue.headers)
          headers.set("cache-control", "no-store")
          return new Response(responseValue.body, {
            status: responseValue.status,
            statusText: responseValue.statusText,
            headers,
          })
        }
        return
      }

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
      // openApiJsonSchema below emits OpenAPI 3.0 nullable schemas.
      openapiVersion: "3.0.3",
      documentation: {
        info: {
          title: "Sixb API",
          version: "0.1.0",
          description: "Ontology-first digital twins runtime API",
        },
        components: {
          securitySchemes: {
            [SIXB_CSRF_SECURITY_SCHEME_ID]: SIXB_CSRF_SECURITY_SCHEME,
            [SIXB_SESSION_SECURITY_SCHEME_ID]: SIXB_SESSION_SECURITY_SCHEME,
            [SIXB_ACCESS_TOKEN_SECURITY_SCHEME_ID]: SIXB_ACCESS_TOKEN_SECURITY_SCHEME,
            [SIXB_SHARED_GRANT_SECURITY_SCHEME_ID]: SIXB_SHARED_GRANT_SECURITY_SCHEME,
          },
          schemas: { ...ObjectQueryOpenApiSchemas, ...NamedOpenApiSchemas },
        },
        // Every operation needs a session unless it says otherwise; public ones declare `[]`.
        security: SIXB_SESSION_SECURITY_REQUIREMENT,
        tags: OPENAPI_TAG_METADATA,
      },
      swagger: {
        withCredentials: true,
      },
      mapJsonSchema: {
        zod: openApiJsonSchema,
      },
    })
  )

  const authExperience = server.getAuthExperience()
  registerAuthRoutes(app, host, {
    resolveAuthRedirectContext: (request, input) =>
      server.resolveAuthRedirectContext(request, input),
    resolveAuthRequestOrigin: (request) => server.resolveAuthRequestOrigin(request),
    authExperience: authExperience && { ...authExperience, locale: host.locale },
    resolveInvitationRedirectContext: (request, input) =>
      server.resolveInvitationRedirectContext(request, input),
  })
  registerHttpRoutes(app, host, {
    sharedAccess,
    browserPolicy: apiBrowserPolicy,
    isStopping: () => server.isStopping(),
    connectorConnections: {
      resolveReturnTo: (request, returnTo) =>
        server.resolveAuthRedirectContext(request, { returnTo }).returnTo,
      resolveCallbackUrl: (request) =>
        new URL("/auth/connectors/callback", server.resolveAuthRequestOrigin(request)).toString(),
    },
  })
  registerWebhookRoutes(app, host)
  registerWebSocketRoutes(app, server, sharedAccess)

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

  // A frame's page has an opaque origin, so what it loads arrives with `Origin: null`. Its token
  // is the credential and no cookie counts there, so frames are the one place that is allowed, and
  // only to read, as `classifyRoute` makes them public.
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    new URL(request.url).pathname.startsWith(ARTIFACT_FRAME_ROUTE_PREFIX)
  ) {
    return undefined
  }

  if (isAllowedApiBrowserOrigin(policy, request)) {
    return undefined
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
    readonly resolveClientAddress: ClientAddressResolver
    readonly timing: SixbRequestTimingOptions
  }
) {
  const openSockets = new Set<ServerWebSocket<unknown>>()
  const bunServer = Bun.serve({
    port: options.port,
    hostname: options.host,
    // No route reads more than a staged upload's content, so Bun rejects anything larger with 413.
    // Every other body is refused below when it declares more than its route reads, and capped by
    // `limitRequestBody` as it streams.
    maxRequestBodySize: MAX_FILE_UPLOAD_BYTES,
    fetch: (incoming: Request, server: Server<unknown>) => {
      const tooLarge = declaredBodyTooLarge(incoming)
      if (tooLarge) return Response.json({ error: tooLarge.message }, { status: 413 })

      // A branch's copy can go quiet for far longer than Bun's 10 s idle timeout, while production
      // cuts a large lake or reads through a selective view condition. Only the request Bun
      // handed in can lift it: the capped one below is another object.
      if (isBranchCopy(incoming)) server.timeout(incoming, 0)

      const socketAddress = server.requestIP(incoming)?.address
      // Elysia parses a body before the auth guard runs, so cap it here, as it streams. The capped
      // request replaces this one before any state is keyed to it.
      const request = limitRequestBody(incoming)
      if (socketAddress) {
        const forwardedFor = request.headers.get("x-forwarded-for")
        setRequestClientAddress(request, options.resolveClientAddress(socketAddress, forwardedFor))
      }
      return timeRequest(request, options.timing, () => app.fetch(request))
    },
    websocket: getElysiaWsHandler(app, openSockets),
  } as Parameters<typeof Bun.serve>[0])

  attachBunServer(app, bunServer)
  return {
    bunServer,
    closeWebSockets: () => {
      for (const ws of [...openSockets]) {
        try {
          ws.close(SERVICE_RESTART_CLOSE_CODE, "Service Restart")
        } catch {
          // Already closed.
        }
      }
      openSockets.clear()
    },
  }
}

function isBranchCopy(request: Request): boolean {
  return request.method === "POST" && new URL(request.url).pathname === "/api/branches/copy"
}

function getElysiaWsHandler(app: SixbApp, openSockets: Set<ServerWebSocket<unknown>>) {
  const cfg = (app as unknown as { config?: { websocket?: Record<string, unknown> } }).config
  const base = {
    ...elysiaWebSocket,
    ...(cfg?.websocket ?? {}),
  } as NonNullable<Parameters<typeof Bun.serve>[0]["websocket"]>
  return {
    ...base,
    maxPayloadLength: MAX_WEBSOCKET_MESSAGE_BYTES,
    open(ws: ServerWebSocket<unknown>) {
      openSockets.add(ws)
      return base.open?.(ws)
    },
    close(ws: ServerWebSocket<unknown>, code: number, reason: string) {
      openSockets.delete(ws)
      return base.close?.(ws, code, reason)
    },
  } as Parameters<typeof Bun.serve>[0]["websocket"]
}

function resolveStopTimeoutMs(timeoutMs: number | undefined, fallbackMs: number): number {
  const resolved = timeoutMs ?? fallbackMs
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error("[SixbServer] Stop timeout must be a non-negative finite number.")
  }
  return resolved
}

/** A stop under way: a later `stop()` joins `done` and may bring `deadline` closer. */
interface InProgressStop {
  readonly deadline: StopDeadline
  readonly done: Promise<void>
}

/** When a stopping server gives up on in-flight requests. A later `stop()` can only bring it closer. */
class StopDeadline {
  private at: number

  constructor(timeoutMs: number) {
    this.at = Date.now() + timeoutMs
  }

  remainingMs(): number {
    return this.at - Date.now()
  }

  bringForward(timeoutMs: number): void {
    this.at = Math.min(this.at, Date.now() + timeoutMs)
  }
}

async function drainBunServer(
  server: ReturnType<typeof Bun.serve>,
  deadline: StopDeadline,
  beforeWait: () => Promise<void>
): Promise<void> {
  if (deadline.remainingMs() <= 0) {
    try {
      await beforeWait()
    } finally {
      await server.stop(true)
    }
    return
  }

  const draining = server.stop(false)
  try {
    await beforeWait()
  } catch (error) {
    await server.stop(true)
    await draining
    throw error
  }

  // Bun's `stop(false)` can stay pending on an already-answered 413 socket whose unread upload
  // body has not hit its idle timeout yet, even though `pendingRequests` is already 0.
  await waitUntilIdleOrTimeout(server, draining, deadline)
  await server.stop(true)
  await draining
}

/** Polls every 25 ms, so a deadline brought forward takes effect within one poll. */
async function waitUntilIdleOrTimeout(
  server: ReturnType<typeof Bun.serve>,
  draining: Promise<void>,
  deadline: StopDeadline
): Promise<void> {
  let settled = false
  void draining.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )

  while (!settled && (server.pendingRequests > 0 || server.pendingWebSockets > 0)) {
    const remaining = deadline.remainingMs()
    if (remaining <= 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        draining,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(remaining, 25))
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

function attachBunServer(app: SixbApp, bunServer: ReturnType<typeof Bun.serve>) {
  ;(app as unknown as { server: typeof bunServer }).server = bunServer
}

/**
 * Runs Elysia's `onStop` hooks (such as `LiveRooms.close()`) and awaits their promises without
 * waiting on `bunServer.stop(false)` first, which stays pending while WebSockets are still open.
 */
async function stopElysiaHooks(app: SixbApp): Promise<void> {
  const internal = app as unknown as {
    server: unknown
    event?: { stop?: ReadonlyArray<{ fn: (instance: SixbApp) => unknown }> }
  }
  const hooks = internal.event?.stop ?? []
  internal.server = null
  await Promise.all(hooks.map((hook) => Promise.resolve(hook.fn(app))))
}

/**
 * The person a branch from production runs as, with the groups production gave them, which the
 * copy carried. Null off such a branch.
 */
async function branchPersonContext(host: SixbHostView) {
  const runtime = branchRuntimeOf(host)
  if (!runtime) return null

  const userId = runtime.person.userId
  const memberships =
    (await host.storage.auth?.groupMemberships.listForUser({ projectId: host.id, userId })) ?? []
  return resolveAuthorizationContext({
    principal: { type: "user", id: userId },
    groupIds: memberships.map((membership) => membership.groupId),
    roles: host.definitions.security.listResolvedRoles(),
  })
}

function bearerOf(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? ""
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null
}

/** Whether a request names this machine: localhost (and `*.localhost`), 127.0.0.1 or [::1]. */
function isLoopbackHost(request: Request): boolean {
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase()
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]
  return (
    name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1" || name === "[::1]"
  )
}
