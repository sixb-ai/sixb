import { join } from "node:path"
import {
  type AuthSessionAudience,
  DEFAULT_AUTH_SESSION_AUDIENCE,
  resolveAuthSessionAudience,
} from "@pario/core"
import { ensureBuiltInUiBundle, renderBuiltInUiShell } from "./ui/assets"
import { type BuiltInUiCssHandle, ensureBuiltInUiCss } from "./ui/css"

export interface CreateAtlasAppOptions {
  readonly apiBaseUrl: string
  readonly audience?: AuthSessionAudience
}

export interface AtlasAppStartOptions {
  readonly host?: string
  readonly port?: number
  readonly development?: boolean
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

export function createAtlasApp(options: CreateAtlasAppOptions): AtlasAppInstance {
  const apiBaseUrl = normalizeOrigin(options.apiBaseUrl, "Atlas API base URL")
  const audience = resolveAuthSessionAudience(options.audience ?? DEFAULT_AUTH_SESSION_AUDIENCE)

  return {
    async start(startOptions: AtlasAppStartOptions = {}) {
      const host = startOptions.host ?? "0.0.0.0"
      const port = startOptions.port ?? 3000
      const development = startOptions.development ?? process.env.NODE_ENV === "development"
      let css: BuiltInUiCssHandle | null = null

      try {
        css = await ensureBuiltInUiCss({ watch: development })
        const bundle = await ensureBuiltInUiBundle()
        const shell = renderBuiltInUiShell({ apiBaseUrl, audience })
        const server = Bun.serve({
          port,
          hostname: host,
          development,
          fetch: (request) => atlasResponse(request, { bundleOutdir: bundle.outdir, shell }),
        })
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
        throw new Error(`[ParioAtlas] Failed to listen on ${host}:${port}: ${message}`)
      }
    },
  }
}

async function atlasResponse(
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
    return await fileResponse(request, join(import.meta.dir, "ui", "favicon.svg"))
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

function isAssetRequest(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? ""
  return /\.[^/]+$/.test(lastSegment)
}

function normalizeOrigin(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[ParioAtlas] Invalid ${label}: '${value}'.`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`[ParioAtlas] ${label} must use http or https.`)
  }

  return url.origin
}
