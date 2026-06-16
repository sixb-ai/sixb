import { watch } from "node:fs"
import { access, cp } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, resolve } from "node:path"
import { type BuildAppResult, buildApp } from "./build"
import { generateAppEntry, generateRouteManifest } from "./codegen"
import { renderCustomAppRuntimeScript } from "./runtime"
import { type PageRoute, scanPages } from "./scanner"
import { type CustomAppStylesheet, resolveCustomAppStylesheet } from "./styles"
import { createTailwindCssCompiler, type TailwindCssCompiler } from "./tailwind"

export interface CreateCustomAppOptions {
  rootDir: string
  appDir?: string
  generatedDir?: string
  publicDir?: string
  apiBaseUrl?: string
  audience?: string
  authEnabled?: boolean
}

export interface CustomAppDevOptions {
  host?: string
  port?: number
}

export interface CustomAppBuildOptions {
  outdir?: string
}

export interface CustomAppStartOptions {
  host?: string
  port?: number
  outdir?: string
  apiBaseUrl?: string
  audience?: string
  authEnabled?: boolean
}

export interface CustomAppDevServer {
  host: string
  port: number
  url: string
  stop(): Promise<void>
}

export interface CustomAppInstance {
  scanRoutes(): Promise<PageRoute[]>
  hasRoutes(): Promise<boolean>
  dev(options?: CustomAppDevOptions): Promise<CustomAppDevServer>
  build(options?: CustomAppBuildOptions): Promise<BuildAppResult>
  start(options?: CustomAppStartOptions): Promise<CustomAppDevServer>
}

type BunServeRoutes = NonNullable<Parameters<typeof Bun.serve>[0]["routes"]>
type BunServeRoute = BunServeRoutes[string]

export async function createCustomApp(options: CreateCustomAppOptions): Promise<CustomAppInstance> {
  const rootDir = resolve(options.rootDir)
  const appDir = options.appDir ? resolve(rootDir, options.appDir) : resolve(rootDir, "app")
  const generatedDir = resolve(rootDir, options.generatedDir ?? join(".sixb", "generated"))
  const publicDir = options.publicDir
    ? resolve(rootDir, options.publicDir)
    : resolve(appDir, "public")
  const apiBaseUrl = options.apiBaseUrl
  const audience = options.audience ?? "app"
  const authEnabled = options.authEnabled ?? true

  async function scanRoutes(): Promise<PageRoute[]> {
    if (!(await pathExists(appDir))) {
      return []
    }

    return await scanPages(appDir)
  }

  let tailwindCompiler: TailwindCssCompiler | null = null

  // `app/globals.css` is source. When it uses Tailwind, compile it to
  // `.sixb/generated/app.css` and bundle that; plain CSS bundles as-is. This
  // runs in both dev and build, so `sixb build` alone always produces fresh CSS.
  async function prepareStylesheet(): Promise<CustomAppStylesheet> {
    const stylesheet = await resolveCustomAppStylesheet({ appDir, generatedDir, rootDir })
    if (stylesheet.kind !== "tailwind") {
      return stylesheet
    }

    tailwindCompiler ??= createTailwindCssCompiler({
      inputPath: stylesheet.sourcePath,
      outputPath: stylesheet.outputPath,
      // Scope Tailwind's automatic source detection to app/ so it never walks
      // vendor/ or unrelated trees; resolve the CLI from the project's deps.
      cwd: appDir,
      resolveFrom: rootDir,
      label: "[SixbCustomApp]",
    })
    await tailwindCompiler.compile()
    return stylesheet
  }

  async function prepareGeneratedApp(): Promise<{ htmlPath: string; routes: PageRoute[] }> {
    const routes = await scanRoutes()
    if (routes.length === 0) {
      throw new Error(`[SixbCustomApp] No app routes found in ${appDir}`)
    }

    const stylesheet = await prepareStylesheet()
    await generateRouteManifest(routes, generatedDir)
    const { htmlPath } = await generateAppEntry(rootDir, generatedDir, {
      apiBaseUrl,
      audience,
      authEnabled,
      appDir,
      stylesheetPath:
        stylesheet.kind === "none"
          ? null
          : stylesheet.kind === "static"
            ? stylesheet.path
            : stylesheet.outputPath,
    })
    return { htmlPath, routes }
  }

  return {
    async scanRoutes() {
      return await scanRoutes()
    },

    async hasRoutes() {
      const routes = await scanRoutes()
      return routes.length > 0
    },

    async dev(devOptions: CustomAppDevOptions = {}) {
      const host = devOptions.host ?? "0.0.0.0"
      const port = devOptions.port ?? 3001
      const { htmlPath } = await prepareGeneratedApp()
      const htmlModule = await import(htmlPath)
      const publicRoutes = (await pathExists(publicDir)) ? await createPublicRoutes(publicDir) : {}
      const server = Bun.serve({
        port,
        hostname: host,
        development: true,
        routes: {
          ...publicRoutes,
          ...reservedSixbRoutes(),
          "/": htmlBundleRoute(htmlModule.default),
          "/*": htmlBundleRoute(htmlModule.default),
        },
      } as Parameters<typeof Bun.serve>[0])

      // .ts/.tsx edits can change Tailwind's scanned classes and .css edits
      // change the stylesheet source, so both regenerate the entry and
      // recompile CSS. Debounced so a burst of saves builds once.
      let rebuildTimer: ReturnType<typeof setTimeout> | null = null
      const watcher = watch(appDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        if (!/\.(ts|tsx|css)$/.test(String(filename))) return

        if (rebuildTimer) {
          clearTimeout(rebuildTimer)
        }
        rebuildTimer = setTimeout(() => {
          rebuildTimer = null
          prepareGeneratedApp().catch((error) => {
            // Keep serving the last good build, but tell the user why styles
            // or routes are stale instead of failing silently.
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[SixbCustomApp] Rebuild failed: ${message}`)
          })
        }, 80)
      })

      const displayHost = host === "0.0.0.0" ? "localhost" : host

      return {
        host,
        port,
        url: `http://${displayHost}:${port}`,
        async stop() {
          if (rebuildTimer) {
            clearTimeout(rebuildTimer)
            rebuildTimer = null
          }
          watcher.close()
          await tailwindCompiler?.stop()
          server.stop(true)
        },
      }
    },

    async build(buildOptions: CustomAppBuildOptions = {}) {
      const outdir = resolve(rootDir, buildOptions.outdir ?? join(".sixb", "dist", "app"))
      const { htmlPath } = await prepareGeneratedApp()
      const result = await buildApp({
        entryPath: htmlPath,
        outdir,
      })

      if (result.success && (await pathExists(publicDir))) {
        await cp(publicDir, outdir, {
          recursive: true,
          force: true,
        })
      }

      return result
    },

    async start(startOptions: CustomAppStartOptions = {}) {
      const host = startOptions.host ?? "0.0.0.0"
      const port = startOptions.port ?? 3001
      const outdir = resolve(rootDir, startOptions.outdir ?? join(".sixb", "dist", "app"))
      const indexPath = join(outdir, "index.html")

      if (!(await pathExists(indexPath))) {
        throw new Error(`[SixbCustomApp] No built app found in ${outdir}`)
      }

      const indexHtml = injectRuntimeConfig(await Bun.file(indexPath).text(), {
        apiBaseUrl: startOptions.apiBaseUrl ?? apiBaseUrl,
        audience: startOptions.audience ?? audience,
        authEnabled: startOptions.authEnabled ?? authEnabled,
      })
      const server = Bun.serve({
        port,
        hostname: host,
        development: false,
        async fetch(req) {
          const url = new URL(req.url)
          if (isReservedSixbRoute(url.pathname)) {
            return notFoundResponse()
          }

          if (req.method !== "GET" && req.method !== "HEAD") {
            return notFoundResponse()
          }

          if (url.pathname === "/" || url.pathname === "") {
            return htmlResponse(req, indexHtml)
          }

          const resolvedPath = resolveStaticPath(outdir, url.pathname)
          if (!resolvedPath) {
            return notFoundResponse()
          }

          const directFile = Bun.file(resolvedPath)
          if (await directFile.exists()) {
            return fileResponse(req, directFile, immutableAssetHeaders(url.pathname))
          }

          if (isAssetRequest(url.pathname)) {
            return notFoundResponse()
          }

          const htmlFile = Bun.file(`${resolvedPath}.html`)
          if (await htmlFile.exists()) {
            return fileResponse(req, htmlFile)
          }

          const nestedIndexFile = Bun.file(join(resolvedPath, "index.html"))
          if (await nestedIndexFile.exists()) {
            return fileResponse(req, nestedIndexFile)
          }

          return htmlResponse(req, indexHtml)
        },
      })

      const displayHost = host === "0.0.0.0" ? "localhost" : host

      return {
        host,
        port,
        url: `http://${displayHost}:${port}`,
        async stop() {
          server.stop(true)
        },
      }
    },
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function createPublicRoutes(publicDir: string): Promise<BunServeRoutes> {
  const files = new Bun.Glob("**/*").scan({
    cwd: publicDir,
    absolute: true,
    onlyFiles: true,
  })
  const routes: BunServeRoutes = {}

  for await (const filePath of files) {
    const routePath = `/${filePath
      .slice(publicDir.length + 1)
      .split("\\")
      .join("/")}`
    if (isReservedSixbRoute(routePath)) {
      continue
    }
    routes[routePath] = getHeadRoute((request) => filePathResponse(request, filePath))
  }

  return routes
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

// Static-asset extensions whose absence should 404 rather than fall back to the
// SPA shell — otherwise the browser would receive HTML for a missing
// script/style/image and fail with a confusing content-type error.
const ASSET_EXTENSIONS = new Set([
  "js",
  "mjs",
  "cjs",
  "css",
  "map",
  "json",
  "wasm",
  "ico",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "bmp",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "mp4",
  "webm",
  "ogg",
  "mp3",
  "wav",
  "txt",
  "xml",
  "webmanifest",
  "pdf",
])

function isAssetRequest(pathname: string): boolean {
  // Decode first: client routes can carry percent-encoded slashes (`%2F`) inside a
  // single path segment (e.g. an object id), so the raw pathname's "last segment"
  // is unreliable. Falling back to the SPA shell for these is the whole point.
  let decoded = pathname
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    // Keep the raw pathname when it isn't valid percent-encoding.
  }
  const lastSegment = decoded.split(/[\\/]+/).pop() ?? ""
  const dot = lastSegment.lastIndexOf(".")
  // No extension, a leading-dot file, or a trailing dot → not an asset request.
  if (dot <= 0 || dot === lastSegment.length - 1) return false
  return ASSET_EXTENSIONS.has(lastSegment.slice(dot + 1).toLowerCase())
}

function resolveStaticPath(appRoot: string, pathname: string): string | null {
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }

  if (decodedPath.includes("\0")) return null
  const segments = decodedPath.split(/[\\/]+/)
  if (segments.includes("..")) return null

  const normalizedPath = normalize(decodedPath).replace(/^[\\/]+/, "")
  const resolvedPath = resolve(appRoot, normalizedPath)
  const rel = relative(appRoot, resolvedPath)

  if (rel.startsWith("..") || isAbsolute(rel)) return null
  return resolvedPath
}

function injectRuntimeConfig(
  html: string,
  config: {
    readonly apiBaseUrl?: string
    readonly audience: string
    readonly authEnabled: boolean
  }
): string {
  if (!config.apiBaseUrl) {
    return html
  }

  const script = renderCustomAppRuntimeScript({
    api: { baseUrl: config.apiBaseUrl },
    auth: { audience: config.audience, enabled: config.authEnabled },
  })
  const existingRuntimeScript = /<script>window\.__SIXB_RUNTIME__ = .*?;<\/script>/
  if (existingRuntimeScript.test(html)) {
    return html.replace(existingRuntimeScript, script)
  }

  if (html.includes("</head>")) {
    return html.replace("</head>", `  ${script}\n  </head>`)
  }

  return `${script}\n${html}`
}

function htmlResponse(request: Request, html: string): Response {
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

// Bun.build emits content-hashed bundles named `chunk-<hash>.<ext>` (see buildApp).
// Their contents can never change under the same URL, so they are safe to cache
// forever — matching how Atlas serves its hashed assets. Files copied
// from `public/` keep their names across deploys and stay uncached.
const IMMUTABLE_ASSET_PATTERN = /^chunk-[a-z0-9]+\.(js|css|js\.map|css\.map)$/

function immutableAssetHeaders(pathname: string): Record<string, string> {
  const lastSegment = pathname.split("/").pop() ?? ""
  if (!IMMUTABLE_ASSET_PATTERN.test(lastSegment)) {
    return {}
  }

  return { "cache-control": "public, max-age=31536000, immutable" }
}

function fileResponse(
  request: Request,
  file: Bun.BunFile,
  headers: Record<string, string> = {}
): Response {
  return new Response(request.method === "HEAD" ? null : file, { headers })
}

function filePathResponse(request: Request, path: string): Response {
  return fileResponse(request, Bun.file(path))
}

function notFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "cache-control": "no-store",
    },
  })
}

function getHeadRoute(handler: (request: Request) => Response): BunServeRoute {
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
