import { join } from "node:path"
import {
  type AuthSessionAudience,
  DEFAULT_AUTH_SESSION_AUDIENCE,
  resolveAuthSessionAudience,
} from "@sixb/core"
import {
  buildBuiltInUiBundle,
  ensureBuiltInUiDevBundle,
  loadBuiltInUiBundle,
  renderBuiltInUiShell,
} from "./assets"
import { type BuiltInUiCssHandle, buildBuiltInUiCss, ensureBuiltInUiCss } from "./css"

type BunServeRoutes = NonNullable<Parameters<typeof Bun.serve>[0]["routes"]>
type BunServeRoute = BunServeRoutes[string]
const sourceDir = join(import.meta.dir, "..", "src")
const faviconPath = join(sourceDir, "favicon.svg")

export interface CreateAtlasAppOptions {
  readonly apiBaseUrl: string
  readonly audience?: AuthSessionAudience
  readonly authEnabled?: boolean
}

export interface AtlasAppStartOptions {
  readonly host?: string
  readonly port?: number
  readonly development?: boolean
  readonly outdir?: string
}

export interface AtlasAppServer {
  readonly host: string
  readonly port: number
  readonly url: string
  stop(): Promise<void>
}

export interface AtlasAppInstance {
  start(options?: AtlasAppStartOptions): Promise<AtlasAppServer>
}

export interface BuildAtlasAssetsOptions {
  readonly outdir?: string
}

interface BuiltInUiServerOptions {
  readonly host: string
  readonly port: number
  readonly apiBaseUrl: string
  readonly audience: AuthSessionAudience
  readonly authEnabled: boolean
  readonly outdir?: string
}

export async function buildAtlasAssets(
  options: BuildAtlasAssetsOptions = {}
): Promise<{ outdir: string }> {
  await buildBuiltInUiCss()
  const bundle = await buildBuiltInUiBundle({ outdir: options.outdir })
  return { outdir: bundle.outdir }
}

export function createAtlasApp(options: CreateAtlasAppOptions): AtlasAppInstance {
  const apiBaseUrl = normalizeOrigin(options.apiBaseUrl, "Atlas API base URL")
  const audience = resolveAuthSessionAudience(options.audience ?? DEFAULT_AUTH_SESSION_AUDIENCE)
  const authEnabled = options.authEnabled ?? true

  return {
    async start(startOptions: AtlasAppStartOptions = {}) {
      const host = startOptions.host ?? "0.0.0.0"
      const port = startOptions.port ?? 3000
      const development = startOptions.development ?? process.env.NODE_ENV === "development"
      let css: BuiltInUiCssHandle | null = null

      try {
        // Development compiles and watches CSS in-process. Production serves the
        // prebuilt assets produced by `sixb build` and never compiles at startup.
        let server: ReturnType<typeof Bun.serve>
        if (development) {
          css = await ensureBuiltInUiCss({ watch: true })
          server = await startDevelopmentServer({ host, port, apiBaseUrl, audience, authEnabled })
        } else {
          server = await startProductionServer({
            host,
            port,
            apiBaseUrl,
            audience,
            authEnabled,
            outdir: startOptions.outdir,
          })
        }
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
        throw new Error(`[SixbAtlas] Failed to listen on ${host}:${port}: ${message}`)
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
      ...reservedSixbRoutes(),
      "/__sixb/runtime.json": getHeadRoute((request) => runtimeConfigResponse(request, input)),
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
  const bundle = await loadBuiltInUiBundle({ outdir: input.outdir })
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
    fetch: (request) => atlasResponse(request, { bundleOutdir: bundle.outdir, shell }),
  })
}

async function atlasResponse(
  request: Request,
  options: {
    readonly bundleOutdir: string
    readonly shell: string
  }
): Promise<Response> {
  const url = new URL(request.url)

  if (isReservedSixbRoute(url.pathname)) {
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

  if (url.pathname.startsWith("/__sixb/")) {
    const relativePath = url.pathname.slice("/__sixb/".length)
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
  const originalFile = Bun.file(path)
  if (!(await originalFile.exists())) {
    return notFoundResponse()
  }

  const responseHeaders = new Headers(headers)
  let responseFile = originalFile
  if (path.endsWith(".js") || path.endsWith(".css")) {
    responseHeaders.append("vary", "Accept-Encoding")
    if (!request.headers.has("range")) {
      for (const encoding of acceptedPrecompressedEncodings(request)) {
        const candidate = Bun.file(`${path}.${encoding === "br" ? "br" : "gz"}`)
        if (!(await candidate.exists())) continue

        responseFile = candidate
        responseHeaders.set("content-encoding", encoding)
        responseHeaders.set("content-type", originalFile.type)
        break
      }
    }
  }

  return new Response(request.method === "HEAD" ? null : responseFile, {
    headers: responseHeaders,
  })
}

function acceptedPrecompressedEncodings(request: Request): ("br" | "gzip")[] {
  const header = request.headers.get("accept-encoding")
  if (!header) return []

  const qualities = new Map<string, number>()
  for (const item of header.split(",")) {
    const [rawName, ...parameters] = item.trim().split(";")
    const name = rawName.toLowerCase()
    let quality = 1
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^q=(0(?:\.\d+)?|1(?:\.0+)?)$/)
      if (match) quality = Number(match[1])
    }
    qualities.set(name, quality)
  }

  const wildcard = qualities.get("*") ?? 0
  return (["br", "gzip"] as const)
    .map((encoding, preference) => ({
      encoding,
      preference,
      quality: qualities.get(encoding) ?? wildcard,
    }))
    .filter((candidate) => candidate.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.preference - right.preference)
    .map((candidate) => candidate.encoding)
}

function notFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "cache-control": "no-store",
    },
  })
}

function isReservedSixbRoute(pathname: string): boolean {
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

function reservedSixbRoutes(): BunServeRoutes {
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
  const extension = lastSegment.includes(".") ? lastSegment.split(".").pop()?.toLowerCase() : ""
  return !!extension && staticAssetExtensions.has(extension)
}

const staticAssetExtensions = new Set([
  "avif",
  "css",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "js",
  "json",
  "map",
  "png",
  "svg",
  "txt",
  "webp",
  "woff",
  "woff2",
])

function normalizeOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[SixbAtlas] Invalid ${label}: '${value}'.`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[SixbAtlas] ${label} must use http or https.`)
  }

  return url.origin
}
