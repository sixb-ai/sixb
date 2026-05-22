import type { ServerAuthGuard } from "../auth/guard"
import { proxyHttpRequest, proxyPublicAppRequest } from "./httpProxy"
import { htmlProxyResponse, htmlResponse } from "./runtimeConfig"
import type {
  AppAsset,
  AppPathPattern,
  CustomAppDevelopmentMount,
  CustomAppMount,
  CustomAppProductionMount,
  ParioRuntimeConfig,
} from "./types"

const ALLOWED_HTML_METHODS = "GET, HEAD"
const RESERVED_PATHS = ["/api", "/auth", "/ws", "/docs"] as const

export interface CustomAppRequestOptions {
  readonly request: Request
  readonly app: CustomAppMount
  readonly guard: ServerAuthGuard
  readonly runtimeConfig: ParioRuntimeConfig
  readonly upgradeWebSocket?: (request: Request, target: URL) => Response | undefined
}

export function validateCustomAppMount(app: CustomAppMount): void {
  if (app.kind !== "development") {
    return
  }

  validatePatternList("hmrWebSocketPaths", app.hmrWebSocketPaths)
  validatePatternList("publicProxyPaths", app.publicProxyPaths)

  for (const path of app.publicAssetPaths) {
    validatePath("publicAssetPaths", path)
    if (isReservedPath(path)) {
      throw new Error(`[ParioServer] Custom app public asset cannot shadow reserved path ${path}.`)
    }
  }
}

export function isReservedPath(pathname: string): boolean {
  return RESERVED_PATHS.some(
    (reserved) => pathname === reserved || pathname.startsWith(`${reserved}/`)
  )
}

export async function handleCustomAppRequest(
  options: CustomAppRequestOptions
): Promise<Response | undefined> {
  const url = new URL(options.request.url)

  if (isReservedPath(url.pathname)) {
    return undefined
  }

  if (options.app.kind === "development") {
    return await handleDevelopmentRequest(options.app, options, url)
  }

  return await handleProductionRequest(options.app, options, url)
}

async function handleDevelopmentRequest(
  app: CustomAppDevelopmentMount,
  options: CustomAppRequestOptions,
  url: URL
): Promise<Response | undefined> {
  const target = toUpstreamUrl(app.origin, url)

  if (isWebSocketRequest(options.request)) {
    if (matchesAny(url.pathname, app.hmrWebSocketPaths)) {
      return (
        options.upgradeWebSocket?.(options.request, target) ??
        new Response("WebSocket Upgrade Failed", {
          status: 500,
          headers: { "cache-control": "no-store" },
        })
      )
    }

    return notFound()
  }

  if (!isHtmlMethod(options.request.method)) {
    return methodNotAllowed()
  }

  if (app.publicAssetPaths.has(url.pathname) || matchesAny(url.pathname, app.publicProxyPaths)) {
    return await proxyPublicAppRequest(options.request, target)
  }

  const blocked = await options.guard.requireHtml(options.request)
  if (blocked) {
    return blocked
  }

  return await htmlProxyResponse(
    options.request,
    await proxyHttpRequest(options.request, target),
    options.runtimeConfig
  )
}

async function handleProductionRequest(
  app: CustomAppProductionMount,
  options: CustomAppRequestOptions,
  url: URL
): Promise<Response> {
  if (isWebSocketRequest(options.request)) {
    return notFound()
  }

  if (!isHtmlMethod(options.request.method)) {
    return methodNotAllowed()
  }

  const asset = await app.asset(url.pathname)
  if (asset) {
    return assetResponse(asset, options.request.method)
  }

  if (isAssetPath(url.pathname) && !isHtmlPath(url.pathname)) {
    return notFound()
  }

  const blocked = await options.guard.requireHtml(options.request)
  if (blocked) {
    return blocked
  }

  if (isHtmlPath(url.pathname)) {
    const html = await app.html(url.pathname)
    return html ? htmlResponse(html, options.request.method, options.runtimeConfig) : notFound()
  }

  const html = url.pathname === "/" ? await app.indexHtml() : await app.html(url.pathname)
  return htmlResponse(
    html ?? (await app.indexHtml()),
    options.request.method,
    options.runtimeConfig
  )
}

function validatePatternList(label: string, patterns: readonly AppPathPattern[]): void {
  const seen = new Set<string>()

  for (const pattern of patterns) {
    validatePath(label, pattern.path)

    if (pattern.kind === "prefix" && !pattern.path.endsWith("/")) {
      throw new Error(`[ParioServer] Custom app ${label} prefix ${pattern.path} must end with "/".`)
    }

    if (pattern.kind === "prefix" && pattern.path === "/") {
      throw new Error(`[ParioServer] Custom app ${label} cannot expose "/" as a public prefix.`)
    }

    if (isReservedPath(pattern.path)) {
      throw new Error(
        `[ParioServer] Custom app ${label} cannot shadow reserved path ${pattern.path}.`
      )
    }

    const key = `${pattern.kind}:${pattern.path}`
    if (seen.has(key)) {
      throw new Error(`[ParioServer] Custom app ${label} contains duplicate path ${pattern.path}.`)
    }
    seen.add(key)
  }
}

function validatePath(label: string, path: string): void {
  if (!path.startsWith("/")) {
    throw new Error(`[ParioServer] Custom app ${label} path ${path} must start with "/".`)
  }

  if (path.includes("\0") || path.includes("?") || path.includes("#")) {
    throw new Error(`[ParioServer] Custom app ${label} path ${path} is invalid.`)
  }

  const segments = path.split("/")
  if (segments.includes("..")) {
    throw new Error(`[ParioServer] Custom app ${label} path ${path} must not traverse directories.`)
  }
}

function matchesAny(pathname: string, patterns: readonly AppPathPattern[]): boolean {
  return patterns.some((pattern) =>
    pattern.kind === "exact" ? pathname === pattern.path : pathname.startsWith(pattern.path)
  )
}

function toUpstreamUrl(origin: URL, url: URL): URL {
  return new URL(`${url.pathname}${url.search}`, origin)
}

function isHtmlMethod(method: string): boolean {
  return method === "GET" || method === "HEAD"
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket"
}

function isAssetPath(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? ""
  return /\.[^/]+$/.test(lastSegment)
}

function isHtmlPath(pathname: string): boolean {
  return pathname.toLowerCase().endsWith(".html")
}

function assetResponse(asset: AppAsset, method: string): Response {
  const headers = new Headers()
  if (asset.contentType) headers.set("content-type", asset.contentType)
  if (asset.cacheControl) headers.set("cache-control", asset.cacheControl)
  return new Response(method === "HEAD" ? null : asset.body, { headers })
}

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { allow: ALLOWED_HTML_METHODS },
  })
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 })
}
