import { cors } from "@elysiajs/cors"
import { openapi } from "@elysiajs/openapi"
import { CSRF_HEADER_NAME, type OntologySource, type Sixb } from "@sixb/core"
import { Elysia } from "elysia"
import { websocket as elysiaWebSocket } from "elysia/ws"
import { zodToJsonSchema } from "zod-to-json-schema"
import {
  BrowserOriginError,
  createApiBrowserAuthContextResolver,
  createApiBrowserAuthRedirectContextResolver,
  isAllowedApiBrowserOrigin,
  type RequestAuthContext,
  type ResolveAuthRedirectContext,
  type ResolvedSixbApiBrowserPolicy,
  type ResolveRequestAuthContext,
  resolveApiBrowserPolicy,
  resolveApiBrowserPublicOrigin,
  type SixbApiBrowserPolicy,
} from "./auth/browser-origin"
import { ServerAuthGuard } from "./auth/guard"
import { SIXB_CSRF_SECURITY_SCHEME, SIXB_CSRF_SECURITY_SCHEME_ID } from "./openapi/security"
import { registerHttpRoutes } from "./registerRoutes"
import { registerAuthRoutes } from "./routes/auth"
import { registerWebhookRoutes } from "./routes/webhooks"
import { registerWsRoutes } from "./routes/ws"

export interface SixbServerOptions {
  sixb: Sixb<readonly OntologySource[]>
  port?: number
  host?: string
  quiet?: boolean
  browser: SixbApiBrowserPolicy
}

export function createSixbServer(options: SixbServerOptions): SixbServer {
  return new SixbServer(options)
}

export class SixbServer {
  private readonly sixb: Sixb<readonly OntologySource[]>
  private readonly port: number
  private readonly host: string
  private readonly quiet: boolean
  private readonly apiBrowserPolicy: ResolvedSixbApiBrowserPolicy
  private readonly authContextResolver: ResolveRequestAuthContext
  private readonly authRedirectContextResolver: ResolveAuthRedirectContext
  private app: SixbApp | null = null
  private bunServer: ReturnType<typeof Bun.serve> | null = null

  constructor(options: SixbServerOptions) {
    this.sixb = options.sixb
    this.port = options.port ?? 3000
    this.host = options.host ?? "0.0.0.0"
    this.quiet = options.quiet ?? false
    this.apiBrowserPolicy = resolveApiBrowserPolicy(options.browser)
    this.authContextResolver = createApiBrowserAuthContextResolver(this.apiBrowserPolicy)
    this.authRedirectContextResolver = createApiBrowserAuthRedirectContextResolver(
      this.apiBrowserPolicy
    )
  }

  getSixb(): Sixb<readonly OntologySource[]> {
    return this.sixb
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

  getApiBrowserPolicy(): ResolvedSixbApiBrowserPolicy {
    return this.apiBrowserPolicy
  }

  async start(): Promise<void> {
    this.app = createSixbApi(this)

    try {
      this.bunServer = startApiServer(this.app, {
        host: this.host,
        port: this.port,
      })
    } catch (error) {
      this.app = null
      this.bunServer = null
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[SixbServer] Failed to listen on ${this.host}:${this.port}: ${message}`)
    }

    if (!this.quiet) {
      const base = `http://${this.host}:${this.port}`
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
  }
}

export function createSixbApi(server: SixbServer) {
  const sixb = server.getSixb()
  const guard = new ServerAuthGuard({
    sixb,
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
      allowedHeaders: ["content-type", CSRF_HEADER_NAME],
      exposeHeaders: [],
      maxAge: 600,
    })
  )

  app.onBeforeHandle(({ request }) => guard.handle(request))

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
          },
        },
        tags: [
          { name: "Project", description: "Current project metadata" },
          { name: "Status", description: "Runtime status" },
          { name: "Ontology", description: "Object type definitions" },
          { name: "Connectors", description: "Connector metadata and webhook routes" },
          { name: "Webhooks", description: "Webhook run history" },
          { name: "Datasets", description: "Dataset definitions, versions, and row previews" },
          { name: "Syncs", description: "Sync metadata and run history" },
          { name: "Pipelines", description: "Pipeline metadata and run history" },
          { name: "Workflows", description: "Workflow metadata and run history" },
          { name: "Rules", description: "Rule definitions and active states" },
          { name: "Projections", description: "Projection definitions" },
          { name: "Objects", description: "Twin objects and state" },
          { name: "Actions", description: "Global and object action requests" },
          { name: "Links", description: "Object relationship links" },
          { name: "Telemetry", description: "Telemetry history and appends" },
          { name: "Events", description: "Domain event stream" },
          { name: "Auth", description: "Authentication session routes" },
        ],
      },
      swagger: {
        withCredentials: true,
      },
      mapJsonSchema: {
        zod: (schema: Parameters<typeof zodToJsonSchema>[0]) =>
          zodToJsonSchema(schema, { $refStrategy: "none", target: "openApi3" }),
      },
    })
  )

  registerAuthRoutes(app, sixb, {
    resolveAuthContext: (request) => server.resolveAuthContext(request),
    resolveAuthRedirectContext: (request, input) =>
      server.resolveAuthRedirectContext(request, input),
    resolveAuthRequestOrigin: (request) => server.resolveAuthRequestOrigin(request),
  })
  registerHttpRoutes(app, sixb)
  registerWebhookRoutes(app, sixb)
  registerWsRoutes(app, server)

  return app
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
