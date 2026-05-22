import { watch } from "node:fs"
import type { PageRoute } from "../scanner"
import { collectPublicAssetPaths, createPublicRoutes, pathExists, toUrlPath } from "./paths"
import type { AppPathPattern, CustomAppDevelopmentMount } from "./types"

export interface CreateDevelopmentMountOptions {
  readonly rootDir: string
  readonly appDir: string
  readonly generatedDir: string
  readonly publicDir: string
  readonly host?: string
  readonly port?: number
  prepareGeneratedApp(): Promise<{ htmlPath: string; routes: PageRoute[] }>
}

export interface ParioAppDevServer {
  readonly host: string
  readonly port: number
  readonly url: string
  stop(): Promise<void>
}

export async function startDevelopmentServer(
  options: CreateDevelopmentMountOptions,
  params: { readonly internal?: boolean } = {}
): Promise<ParioAppDevServer> {
  const host = options.host ?? (params.internal ? "127.0.0.1" : "0.0.0.0")
  const port = options.port ?? (params.internal ? 0 : 3001)
  const { htmlPath } = await options.prepareGeneratedApp()
  const htmlModule = await import(htmlPath)
  const publicRoutes = (await pathExists(options.publicDir))
    ? await createPublicRoutes(options.publicDir)
    : {}
  const server = Bun.serve({
    port,
    hostname: host,
    development: true,
    routes: {
      ...publicRoutes,
      "/": htmlModule.default,
      "/*": htmlModule.default,
    },
  } as Parameters<typeof Bun.serve>[0])

  const watcher = watch(options.appDir, { recursive: true }, async (_eventType, filename) => {
    if (!filename) return
    if (!filename.endsWith(".tsx") && !filename.endsWith(".ts")) return

    try {
      await options.prepareGeneratedApp()
    } catch {
      // Ignore transient rebuild errors during dev; Bun keeps serving the last good bundle.
    }
  })

  const actualPort = server.port
  if (actualPort === undefined) {
    throw new Error("[ParioApp] Could not resolve the development server port.")
  }
  const displayHost = host === "0.0.0.0" ? "localhost" : host

  return {
    host,
    port: actualPort,
    url: `http://${displayHost}:${actualPort}`,
    async stop() {
      watcher.close()
      server.stop(true)
    },
  }
}

export async function createDevelopmentMount(
  options: CreateDevelopmentMountOptions
): Promise<CustomAppDevelopmentMount> {
  const server = await startDevelopmentServer(options, { internal: true })
  const generatedPath = toUrlPath(options.rootDir, options.generatedDir)
  const appPath = toUrlPath(options.rootDir, options.appDir)
  const publicAssetPaths = (await pathExists(options.publicDir))
    ? await collectPublicAssetPaths(options.publicDir)
    : new Set<string>()

  return {
    kind: "development",
    origin: new URL(server.url),
    hmrWebSocketPaths: [{ kind: "exact", path: "/_bun/hmr" }],
    publicProxyPaths: normalizePatterns([
      { kind: "prefix", path: "/_bun/" },
      { kind: "prefix", path: "/node_modules/" },
      { kind: "prefix", path: ensurePrefixPath(generatedPath) },
      { kind: "prefix", path: ensurePrefixPath(appPath) },
    ]),
    publicAssetPaths,
    async stop() {
      await server.stop()
    },
  }
}

function ensurePrefixPath(path: string): string {
  const normalized = `/${path.replace(/^\/+/, "")}`
  return normalized.endsWith("/") ? normalized : `${normalized}/`
}

function normalizePatterns(patterns: readonly AppPathPattern[]): readonly AppPathPattern[] {
  const seen = new Set<string>()
  const result: AppPathPattern[] = []

  for (const pattern of patterns) {
    const key = `${pattern.kind}:${pattern.path}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    result.push(pattern)
  }

  return result
}
