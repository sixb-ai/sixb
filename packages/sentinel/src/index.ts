import { join } from "node:path"
import { type AuthSessionAudience, resolveAuthSessionAudience } from "@pario/core"
import { ensureBuiltInUiBundle, ensureBuiltInUiDevBundle, renderBuiltInUiShell } from "./assets"
import { type BuiltInUiCssHandle, ensureBuiltInUiCss } from "./css"

const DEFAULT_SENTINEL_AUDIENCE = "sentinel"
type BunServeRoutes = NonNullable<Parameters<typeof Bun.serve>[0]["routes"]>
type BunServeRoute = BunServeRoutes[string]
const sourceDir = join(import.meta.dir, "..", "src")
const faviconPath = join(sourceDir, "favicon.svg")

export interface CreateSentinelAppOptions {
  readonly apiBaseUrl: string
  readonly audience?: AuthSessionAudience
  readonly authEnabled?: boolean
}

export interface SentinelAppStartOptions {
  readonly host?: string
  readonly port?: number
  readonly development?: boolean
}

export interface SentinelAppServer {
  readonly host: string
  readonly port: number
  readonly url: string
  stop(): Promise<void>
}

export interface SentinelAppInstance {
  start(options?: SentinelAppStartOptions): Promise<SentinelAppServer>
}

interface BuiltInUiServerOptions {
  readonly host: string
  readonly port: number
  readonly apiBaseUrl: string
  readonly audience: AuthSessionAudience
  readonly authEnabled: boolean
}

export function createSentinelApp(options: CreateSentinelAppOptions): SentinelAppInstance {
  const apiBaseUrl = normalizeOrigin(options.apiBaseUrl, "Sentinel API base URL")
  const audience = resolveAuthSessionAudience(options.audience ?? DEFAULT_SENTINEL_AUDIENCE)
  const authEnabled = options.authEnabled ?? true

  return {
    async start(startOptions: SentinelAppStartOptions = {}) {
      const host = startOptions.host ?? "0.0.0.0"
      const port = startOptions.port ?? 3000
      const development = startOptions.development ?? process.env.NODE_ENV === "development"
      let css: BuiltInUiCssHandle | null = null

      try {
        css = await ensureBuiltInUiCss({ watch: development })
        const server = development
          ? await startDevelopmentServer({ host, port, apiBaseUrl, audience, authEnabled })
          : await startProductionServer({ host, port, apiBaseUrl, audience, authEnabled })
        const displayHost = host === "0.0.0.0" ? "localhost" : host

        return {
          host,
          port,
          url: `http://${displayHost}:${port}`,
          async stop() {
            server.stop(true)
            await css?.stop()
          },
        }
      } catch (error) {
        await css?.stop().catch(() => {})
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`[ParioSentinel] Failed to listen on ${host}:${port}: ${message}`)
      }
    },
  }
}

async function startDevelopmentServer(
  input: BuiltInUiServerOptions
): Promise<ReturnType<typeof Bun.serve>> {
  const bundle = await ensureBuiltInUiDevBundle()

  return Bun.serve({
    port: input.port,
    hostname: input.host,
    development: {
      hmr: true,
      console: true,
    },
    routes: {
      ...reservedParioRoutes(),
      "/__pario/runtime.json": getHeadRoute((request) => runtimeConfigResponse(request, input)),
      "/favicon.svg": getHeadRoute((request) => fileResponse(request, faviconPath)),
      "/favicon.ico": getHeadRoute(() => new Response(null, { status: 204 })),
      "/": htmlBundleRoute(bundle.html),
      "/*": htmlBundleRoute(bundle.html),
    },
  } as Parameters<typeof Bun.serve>[0])
}

async function startProductionServer(
  input: BuiltInUiServerOptions
): Promise<ReturnType<typeof Bun.serve>> {
  const bundle = await ensureBuiltInUiBundle()
  const shell = renderBuiltInUiShell({
    apiBaseUrl: input.apiBaseUrl,
    audience: input.audience,
    authEnabled: input.authEnabled,
    scriptPath: bundle.scriptPath,
    stylesheetPath: bundle.stylesheetPath,
  })

  return Bun.serve({
    port: input.port,
    hostname: input.host,
    development: false,
    fetch: (request) => sentinelResponse(request, { bundleOutdir: bundle.outdir, shell }),
  })
}

async function sentinelResponse(
  request: Request,
  options: {
    readonly bundleOutdir: string
    readonly shell: string
  }
): Promise<Response> {
  const url = new URL(request.url)

  if (isReservedParioRoute(url.pathname)) {
    return notFoundResponse()
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return notFoundResponse()
  }

  if (url.pathname === "/favicon.svg") {
    return await fileResponse(request, faviconPath)
  }

  if (url.pathname === "/favicon.ico") {
    return new Response(null, { status: 204 })
  }

  if (url.pathname.startsWith("/__pario/")) {
    const relativePath = url.pathname.slice("/__pario/".length)
    if (!relativePath || relativePath.includes("\0") || relativePath.includes("..")) {
      return notFoundResponse()
    }

    return await fileResponse(request, join(options.bundleOutdir, relativePath), {
      "cache-control": "public, max-age=31536000, immutable",
    })
  }

  if (isAssetRequest(url.pathname)) {
    return notFoundResponse()
  }

  return htmlResponse(request, options.shell)
}

function htmlResponse(request: Request, html: string): Response {
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function runtimeConfigResponse(request: Request, config: BuiltInUiServerOptions): Response {
  const body = JSON.stringify({
    api: { baseUrl: config.apiBaseUrl },
    auth: { audience: config.audience, enabled: config.authEnabled },
  })

  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

async function fileResponse(
  request: Request,
  path: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    return notFoundResponse()
  }

  return new Response(request.method === "HEAD" ? null : file, { headers })
}

function notFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "cache-control": "no-store",
    },
  })
}

function isReservedParioRoute(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    pathname === "/ws" ||
    pathname.startsWith("/ws/") ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  )
}

function reservedParioRoutes(): BunServeRoutes {
  const handler = () => notFoundResponse()
  return {
    "/api": allMethodsRoute(handler),
    "/api/*": allMethodsRoute(handler),
    "/auth": allMethodsRoute(handler),
    "/auth/*": allMethodsRoute(handler),
    "/ws": allMethodsRoute(handler),
    "/ws/*": allMethodsRoute(handler),
    "/docs": allMethodsRoute(handler),
    "/docs/*": allMethodsRoute(handler),
  }
}

function getHeadRoute(handler: (request: Request) => Response | Promise<Response>): BunServeRoute {
  return {
    GET: handler,
    HEAD: handler,
  } as unknown as BunServeRoute
}

function allMethodsRoute(handler: (request: Request) => Response): BunServeRoute {
  return {
    GET: handler,
    HEAD: handler,
    POST: handler,
    PUT: handler,
    PATCH: handler,
    DELETE: handler,
    OPTIONS: handler,
  } as unknown as BunServeRoute
}

function htmlBundleRoute(bundle: Bun.HTMLBundle): BunServeRoute {
  return {
    GET: bundle,
    HEAD: bundle,
  } as unknown as BunServeRoute
}

function isAssetRequest(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? ""
  return /\.[^/]+$/.test(lastSegment)
}

function normalizeOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[ParioSentinel] Invalid ${label}: '${value}'.`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[ParioSentinel] ${label} must use http or https.`)
  }

  return url.origin
}
