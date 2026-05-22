import { join } from "node:path"
import { cors } from "@elysiajs/cors"
import { openapi } from "@elysiajs/openapi"
import type { OntologySource, Pario } from "@pario/core"
import { Elysia } from "elysia"
import { websocket as elysiaWebSocket } from "elysia/ws"
import { zodToJsonSchema } from "zod-to-json-schema"
import { ServerAuthGuard } from "./auth/guard"
import { PARIO_CSRF_SECURITY_SCHEME, PARIO_CSRF_SECURITY_SCHEME_ID } from "./openapi/security"
import { registerHttpRoutes } from "./registerRoutes"
import { registerAuthRoutes } from "./routes/auth"
import { registerWebhookRoutes } from "./routes/webhooks"
import { registerWsRoutes } from "./routes/ws"
import { ensureBuiltInUiBundle, renderBuiltInUiShell } from "./ui/assets"
import { type BuiltInUiCssHandle, ensureBuiltInUiCss } from "./ui/css"

export interface ParioServerOptions {
  pario: Pario<readonly OntologySource[]>
  port?: number
  host?: string
  quiet?: boolean
  ui?: boolean
}

export function createParioServer(options: ParioServerOptions): ParioServer {
  return new ParioServer(options)
}

export class ParioServer {
  private readonly pario: Pario<readonly OntologySource[]>
  private readonly port: number
  private readonly host: string
  private readonly quiet: boolean
  private readonly ui: boolean
  private app: ParioApp | null = null
  private bunServer: ReturnType<typeof Bun.serve> | null = null
  private uiCss: BuiltInUiCssHandle | null = null

  constructor(options: ParioServerOptions) {
    this.pario = options.pario
    this.port = options.port ?? 3000
    this.host = options.host ?? "0.0.0.0"
    this.quiet = options.quiet ?? false
    this.ui = options.ui ?? true
  }

  getPario(): Pario<readonly OntologySource[]> {
    return this.pario
  }

  getPort(): number {
    return this.port
  }

  private isDevelopmentMode(): boolean {
    return process.env.NODE_ENV === "development"
  }

  async start(): Promise<void> {
    this.app = createParioApi(this)

    try {
      if (this.ui) {
        this.uiCss = await ensureBuiltInUiCss({
          watch: this.isDevelopmentMode(),
        })
        this.bunServer = await this.startUiServer(this.app)
      } else {
        this.app.listen({ port: this.port, hostname: this.host })
      }
    } catch (error) {
      if (this.uiCss) {
        await this.uiCss.stop().catch(() => {})
        this.uiCss = null
      }
      this.app = null
      this.bunServer = null
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`[ParioServer] Failed to listen on ${this.host}:${this.port}: ${message}`)
    }

    if (!this.quiet) {
      const base = `http://${this.host}:${this.port}`
      console.log(`Pario server running at ${base}`)
      console.log(`OpenAPI docs at ${base}/docs`)
      if (this.ui) {
        console.log(`Built-in UI at ${base}/`)
      }
    }
  }

  async stop(): Promise<void> {
    if (this.bunServer) {
      this.bunServer.stop(true)
      this.bunServer = null
    }

    if (this.uiCss) {
      await this.uiCss.stop()
      this.uiCss = null
    }

    if (this.app) {
      await this.app.stop()
      this.app = null
    }
  }

  private async startUiServer(app: ParioApp) {
    const appFetch = (req: Request) => app.fetch(req)
    const guard = new ServerAuthGuard({ pario: this.pario })
    const routes = (
      this.isDevelopmentMode()
        ? await createDevelopmentUiRoutes(guard)
        : await createProductionUiRoutes(guard)
    ) as NonNullable<Parameters<typeof Bun.serve>[0]["routes"]>

    const bunServer = Bun.serve({
      port: this.port,
      hostname: this.host,
      development: this.isDevelopmentMode(),
      routes: {
        "/api/*": appFetch,
        "/auth/*": appFetch,
        "/ws/*": appFetch,
        "/docs": appFetch,
        "/docs/*": appFetch,
        ...routes,
      },
      fetch: appFetch,
      websocket: getElysiaWsHandler(app),
    } as Parameters<typeof Bun.serve>[0])

    attachBunServer(app, bunServer)
    return bunServer
  }
}

export function createParioApi(server: ParioServer) {
  const pario = server.getPario()
  const guard = new ServerAuthGuard({ pario })
  guard.assertCanServeHttp({ production: process.env.NODE_ENV === "production" })

  const app = new Elysia().use(cors()).use(
    openapi({
      path: "/docs",
      provider: "swagger-ui",
      documentation: {
        info: {
          title: "Pario API",
          version: "0.1.0",
          description: "Ontology-first digital twins runtime API",
        },
        components: {
          securitySchemes: {
            [PARIO_CSRF_SECURITY_SCHEME_ID]: PARIO_CSRF_SECURITY_SCHEME,
          },
        },
        tags: [
          { name: "Project", description: "Current project metadata" },
          { name: "Status", description: "Runtime status" },
          { name: "Ontology", description: "Object type definitions" },
          { name: "Connectors", description: "Connector metadata and webhook routes" },
          { name: "Datasets", description: "Dataset definitions, versions, and row previews" },
          { name: "Syncs", description: "Sync metadata and run history" },
          { name: "Pipelines", description: "Pipeline metadata and run history" },
          { name: "Rules", description: "Rule definitions and active states" },
          { name: "Projections", description: "Projection definitions" },
          { name: "Objects", description: "Twin objects and state" },
          { name: "Actions", description: "Object action requests" },
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

  app.onBeforeHandle(({ request }) => guard.handle(request))
  registerAuthRoutes(app, pario)
  registerHttpRoutes(app, pario)
  registerWebhookRoutes(app, pario)
  registerWsRoutes(app, server)

  return app
}

export const createApp = createParioApi
export type ParioApp = ReturnType<typeof createParioApi>

type HtmlRouteHandler = (request: Request) => Response | Promise<Response>

interface HtmlRouteModule {
  default: Bun.HTMLBundle
}

function getElysiaWsHandler(app: ParioApp) {
  const cfg = (app as unknown as { config?: { websocket?: Record<string, unknown> } }).config
  return {
    ...elysiaWebSocket,
    ...(cfg?.websocket ?? {}),
  } as Parameters<typeof Bun.serve>[0]["websocket"]
}

function attachBunServer(app: ParioApp, bunServer: ReturnType<typeof Bun.serve>) {
  ;(app as unknown as { server: typeof bunServer }).server = bunServer
}

async function createBuiltInUiRoutes(): Promise<Record<string, HtmlRouteHandler>> {
  const uiRoot = join(import.meta.dir, "ui")
  return {
    "/favicon.svg": () => new Response(Bun.file(join(uiRoot, "favicon.svg"))),
  }
}

async function createDevelopmentUiRoutes(guard: ServerAuthGuard) {
  const uiRoutes = await createBuiltInUiRoutes()
  if (guard.isAuthEnabled()) {
    return createBundledUiRoutes(guard, uiRoutes)
  }

  const htmlModule = await importBuiltInUiHtmlModule()

  return {
    ...uiRoutes,
    "/": htmlModule.default,
    "/*": htmlModule.default,
  }
}

async function importBuiltInUiHtmlModule(): Promise<HtmlRouteModule> {
  const htmlModuleUrl = new URL("./ui/pario-ui.html", import.meta.url)
  return (await import(htmlModuleUrl.href)) as HtmlRouteModule
}

async function createProductionUiRoutes(guard: ServerAuthGuard) {
  const uiRoutes = await createBuiltInUiRoutes()
  return createBundledUiRoutes(guard, uiRoutes)
}

async function createBundledUiRoutes(
  guard: ServerAuthGuard,
  uiRoutes: Record<string, HtmlRouteHandler>
) {
  const bundle = await ensureBuiltInUiBundle()
  const shell = renderBuiltInUiShell()
  const shellHandler = guard.withProtectedHtml(() => htmlResponse(shell))

  return {
    ...uiRoutes,
    "/__pario/*": (request: Request) => serveBuiltInUiAsset(request, bundle.outdir),
    "/": shellHandler,
    "/*": shellHandler,
  }
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function serveBuiltInUiAsset(request: Request, outdir: string): Response {
  const url = new URL(request.url)
  const relativePath = url.pathname.slice("/__pario/".length)
  const file = Bun.file(join(outdir, relativePath))
  return new Response(file)
}
