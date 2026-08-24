import { randomBytes } from "node:crypto"
import { watch } from "node:fs"
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { AuthSessionAudience } from "@sixb/core"
import {
  type BuildAppResult,
  buildApp,
  prepareAppHtmlBundleEntry,
  restoreAppStaticUrls,
  SHARED_APP_SHELL_FILE_NAME,
} from "./build"
import {
  type BuiltInRouteManifestEntry,
  generateAppEntry,
  generateRouteManifest,
  generateSharedAppEntry,
  generateSharedRouteManifest,
} from "./codegen"
import { renderCustomAppRuntimeScript } from "./runtime"
import { type PageRoute, partitionAppRoutes, scanPages } from "./scanner"
import { type CustomAppStylesheet, resolveCustomAppStylesheet } from "./styles"
import { createTailwindCssCompiler, type TailwindCssCompiler } from "./tailwind"

export interface CreateCustomAppOptions {
  rootDir: string
  appDir?: string
  generatedDir?: string
  publicDir?: string
  apiBaseUrl?: string
  audience?: AuthSessionAudience
  authEnabled?: boolean
  agentRoutes?: boolean
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
  audience?: AuthSessionAudience
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
const packageRoot = resolve(import.meta.dir, "..")
const builtInAgentRouteModule = "@sixb/app/agents"
const builtInAgentRoutePaths = ["/agents", "/agents/new/:agentId", "/agents/:threadId"] as const
const builtInAgentRouteSourcePath = join(packageRoot, "src", "agents.ts")
const customAppManifestRoute = "/app.webmanifest"
const internalAppShellRoute = "/__sixb/generated/app-shell"
const internalSharedAppShellRoute = "/__sixb/generated/shared-app-shell"

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
  const agentRoutesEnabled = options.agentRoutes ?? true

  async function scanRoutes(): Promise<PageRoute[]> {
    if (!(await pathExists(appDir))) {
      return []
    }

    return await scanPages(appDir)
  }

  let tailwindCompiler: TailwindCssCompiler | null = null
  let tailwindCompilerKey: string | null = null
  let builtInAgentCssCompiler: TailwindCssCompiler | null = null

  // `app/globals.css` is source. When it uses Tailwind, compile it to
  // `.sixb/generated/app.css` and bundle that; plain CSS bundles as-is. This
  // runs in both dev and build, so `sixb build` alone always produces fresh CSS.
  async function prepareStylesheet(stylesheet?: CustomAppStylesheet): Promise<CustomAppStylesheet> {
    stylesheet ??= await resolveCustomAppStylesheet({ appDir, generatedDir, rootDir })
    if (stylesheet.kind !== "tailwind") {
      return stylesheet
    }

    await compileAppTailwindStylesheet(stylesheet.sourcePath, stylesheet.outputPath)
    return stylesheet
  }

  async function compileAppTailwindStylesheet(
    inputPath: string,
    outputPath: string
  ): Promise<void> {
    const key = `${inputPath}\0${outputPath}`
    if (tailwindCompilerKey !== key) {
      await tailwindCompiler?.stop()
      tailwindCompiler = createTailwindCssCompiler({
        inputPath,
        outputPath,
        // Scope Tailwind's automatic source detection to app/ so it never walks
        // vendor/ or unrelated trees; resolve the CLI from the project's deps.
        cwd: appDir,
        resolveFrom: rootDir,
        label: "[SixbCustomApp]",
      })
      tailwindCompilerKey = key
    }

    const compiler = tailwindCompiler
    if (!compiler) {
      throw new Error("[SixbCustomApp] Tailwind CSS compiler was not initialized")
    }

    await compiler.compile()
  }

  async function prepareCombinedBuiltInAgentStylesheet(
    stylesheet: Extract<CustomAppStylesheet, { kind: "tailwind" }>
  ): Promise<string> {
    const inputPath = join(generatedDir, "app.input.css")
    const uiGlobalsPath = Bun.resolveSync("@sixb/ui/globals.css", packageRoot)
    const agentUiGlobalsPath = Bun.resolveSync("@sixb/agent-ui/globals.css", packageRoot)
    await writeFileIfChanged(
      inputPath,
      [
        `@import ${JSON.stringify(uiGlobalsPath)};`,
        `@source ${JSON.stringify(builtInAgentRouteSourcePath)};`,
        `@import ${JSON.stringify(stylesheet.sourcePath)};`,
        `@import ${JSON.stringify(agentUiGlobalsPath)};`,
        "",
      ].join("\n")
    )

    await compileAppTailwindStylesheet(inputPath, stylesheet.outputPath)
    return stylesheet.outputPath
  }

  async function prepareStylesheets(builtInRoutes: readonly BuiltInRouteManifestEntry[]): Promise<{
    stylesheetPath: string | null
    frameworkStylesheetPaths: readonly string[]
  }> {
    const stylesheet = await resolveCustomAppStylesheet({ appDir, generatedDir, rootDir })

    if (stylesheet.kind === "tailwind" && builtInRoutes.length > 0) {
      return {
        stylesheetPath: await prepareCombinedBuiltInAgentStylesheet(stylesheet),
        frameworkStylesheetPaths: [],
      }
    }

    const preparedStylesheet = await prepareStylesheet(stylesheet)
    const builtInAgentStylesheetPath = await prepareBuiltInAgentStylesheet(builtInRoutes)

    return {
      frameworkStylesheetPaths: builtInAgentStylesheetPath ? [builtInAgentStylesheetPath] : [],
      stylesheetPath:
        preparedStylesheet.kind === "none"
          ? null
          : preparedStylesheet.kind === "static"
            ? preparedStylesheet.path
            : preparedStylesheet.outputPath,
    }
  }

  async function prepareBuiltInAgentStylesheet(
    builtInRoutes: readonly BuiltInRouteManifestEntry[]
  ): Promise<string | null> {
    if (builtInRoutes.length === 0) {
      return null
    }

    const inputPath = join(generatedDir, "agent-ui.input.css")
    const outputPath = join(generatedDir, "agent-ui.css")
    const uiGlobalsPath = Bun.resolveSync("@sixb/ui/globals.css", packageRoot)
    const agentUiGlobalsPath = Bun.resolveSync("@sixb/agent-ui/globals.css", packageRoot)
    await writeFileIfChanged(
      inputPath,
      [
        `@import ${JSON.stringify(uiGlobalsPath)};`,
        `@source ${JSON.stringify(builtInAgentRouteSourcePath)};`,
        `@import ${JSON.stringify(agentUiGlobalsPath)};`,
        "",
      ].join("\n")
    )

    builtInAgentCssCompiler ??= createTailwindCssCompiler({
      inputPath,
      outputPath,
      cwd: packageRoot,
      resolveFrom: packageRoot,
      label: "[SixbCustomApp]",
    })
    await builtInAgentCssCompiler.compile()
    return outputPath
  }

  async function prepareGeneratedApp(): Promise<{
    htmlPath: string
    sharedHtmlPath: string | null
    manifestPath: string
    routes: PageRoute[]
  }> {
    const routes = await scanRoutes()
    if (routes.length === 0) {
      throw new Error(`[SixbCustomApp] No app routes found in ${appDir}`)
    }

    const { applicationRoutes, sharedRoutes } = partitionAppRoutes(routes)
    const builtInRoutes =
      agentRoutesEnabled && applicationRoutes.length > 0
        ? builtInAgentRoutesFor(applicationRoutes)
        : []
    const stylesheets = await prepareStylesheets(builtInRoutes)
    await generateRouteManifest(applicationRoutes, generatedDir, { builtInRoutes })
    const { htmlPath, manifestPath } = await generateAppEntry(rootDir, generatedDir, {
      apiBaseUrl,
      audience,
      authEnabled,
      appDir,
      publicDir,
      frameworkStylesheetPaths: stylesheets.frameworkStylesheetPaths,
      stylesheetPath: stylesheets.stylesheetPath,
    })
    let sharedHtmlPath: string | null = null
    if (sharedRoutes.length > 0) {
      await generateSharedRouteManifest(sharedRoutes, generatedDir)
      sharedHtmlPath = (
        await generateSharedAppEntry(rootDir, generatedDir, {
          apiBaseUrl,
          appDir,
          publicDir,
          stylesheetPath: stylesheets.stylesheetPath,
        })
      ).htmlPath
    }
    return { htmlPath, sharedHtmlPath, manifestPath, routes }
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
      const { htmlPath, sharedHtmlPath, manifestPath } = await prepareGeneratedApp()
      let htmlImportVersion = 0
      let htmlBundle = await importHtmlBundle(htmlPath, htmlImportVersion)
      let sharedHtmlBundle = sharedHtmlPath
        ? await importHtmlBundle(sharedHtmlPath, htmlImportVersion)
        : null
      const privateSharedAppShellRoute = `${internalSharedAppShellRoute}-${randomBytes(18).toString("base64url")}`
      const publicRoutes = (await pathExists(publicDir)) ? await createPublicRoutes(publicDir) : {}
      let internalOrigin = ""
      const serveOptions = (bundle: Bun.HTMLBundle, sharedBundle: Bun.HTMLBundle | null) =>
        ({
          port,
          hostname: host,
          development: true,
          routes: {
            ...publicRoutes,
            ...reservedSixbRoutes(),
            [customAppManifestRoute]: manifestRoute(manifestPath),
            [internalAppShellRoute]: htmlBundleRoute(bundle),
            ...(sharedBundle
              ? { [privateSharedAppShellRoute]: htmlBundleRoute(sharedBundle) }
              : {}),
            ...sharedAppDevRoutes(
              sharedBundle,
              () => internalOrigin,
              privateSharedAppShellRoute,
              apiBaseUrl
            ),
            "/": spaHtmlRoute(() => internalOrigin),
            "/*": spaHtmlRoute(() => internalOrigin),
          },
        }) as Parameters<typeof Bun.serve>[0]
      const server = Bun.serve(serveOptions(htmlBundle, sharedHtmlBundle))
      internalOrigin = devServerInternalOrigin(host, server.port ?? port)

      // .ts/.tsx edits can change Tailwind's scanned classes and .css edits
      // change the stylesheet source, so both regenerate the entry and
      // recompile CSS. Debounced so a burst of saves builds once.
      let rebuildTimer: ReturnType<typeof setTimeout> | null = null
      let rebuildChain: Promise<void> = Promise.resolve()
      const enqueueRebuild = () => {
        rebuildChain = rebuildChain
          .then(async () => {
            const { htmlPath: nextHtmlPath, sharedHtmlPath: nextSharedHtmlPath } =
              await prepareGeneratedApp()
            htmlImportVersion++
            htmlBundle = await importHtmlBundle(nextHtmlPath, htmlImportVersion)
            sharedHtmlBundle = nextSharedHtmlPath
              ? await importHtmlBundle(nextSharedHtmlPath, htmlImportVersion)
              : null
            server.reload(serveOptions(htmlBundle, sharedHtmlBundle))
          })
          .catch((error) => {
            // Keep serving the last good build, but tell the user why styles
            // or routes are stale instead of failing silently.
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[SixbCustomApp] Rebuild failed: ${message}`)
          })
      }
      const watcher = watch(appDir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return
        if (!/\.(ts|tsx|css)$/.test(String(filename))) return

        if (rebuildTimer) {
          clearTimeout(rebuildTimer)
        }
        rebuildTimer = setTimeout(() => {
          rebuildTimer = null
          enqueueRebuild()
        }, 80)
      })

      // An FSWatcher emits `error` as an event, and an unhandled one takes the whole dev process
      // down — the `.catch()` above only covers a failed rebuild. Losing file watching should cost
      // hot reload, not the server: keep serving the last good build and say so.
      watcher.on("error", (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(
          `[SixbCustomApp] Stopped watching ${appDir}: ${message}. ` +
            "Serving the last build; restart to resume hot reload."
        )
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
          await rebuildChain
          await tailwindCompiler?.stop()
          await builtInAgentCssCompiler?.stop()
          server.stop(true)
        },
      }
    },

    async build(buildOptions: CustomAppBuildOptions = {}) {
      const outdir = resolve(rootDir, buildOptions.outdir ?? join(".sixb", "dist", "app"))
      const { htmlPath, sharedHtmlPath, manifestPath } = await prepareGeneratedApp()
      const result = await buildApp({
        entryPath: htmlPath,
        ...(sharedHtmlPath ? { sharedEntryPath: sharedHtmlPath } : {}),
        manifestPath,
        outdir,
      })

      if (result.success && (await pathExists(publicDir))) {
        const reservedOutputPaths = new Set([
          join(publicDir, "app.webmanifest"),
          join(publicDir, SHARED_APP_SHELL_FILE_NAME),
        ])
        await cp(publicDir, outdir, {
          recursive: true,
          force: true,
          filter: (source) => !reservedOutputPaths.has(resolve(source)),
        })
      }

      return result
    },

    async start(startOptions: CustomAppStartOptions = {}) {
      const host = startOptions.host ?? "0.0.0.0"
      const port = startOptions.port ?? 3001
      const outdir = resolve(rootDir, startOptions.outdir ?? join(".sixb", "dist", "app"))
      const indexPath = join(outdir, "index.html")
      const sharedIndexPath = join(outdir, SHARED_APP_SHELL_FILE_NAME)

      if (!(await pathExists(indexPath))) {
        throw new Error(`[SixbCustomApp] No built app found in ${outdir}`)
      }

      const indexHtml = injectRuntimeConfig(await Bun.file(indexPath).text(), {
        apiBaseUrl: startOptions.apiBaseUrl ?? apiBaseUrl,
        audience: startOptions.audience ?? audience,
        authEnabled: startOptions.authEnabled ?? authEnabled,
      })
      const sharedIndexHtml = (await pathExists(sharedIndexPath))
        ? injectRuntimeConfig(await Bun.file(sharedIndexPath).text(), {
            apiBaseUrl: startOptions.apiBaseUrl ?? apiBaseUrl,
            audience: "app",
            authEnabled: false,
          })
        : null
      const runtimeApiBaseUrl = startOptions.apiBaseUrl ?? apiBaseUrl
      const server = Bun.serve({
        port,
        hostname: host,
        development: false,
        async fetch(req) {
          const url = new URL(req.url)
          if (isReservedSixbRoute(url.pathname)) {
            return notFoundResponse()
          }

          if (url.pathname === `/${SHARED_APP_SHELL_FILE_NAME}`) {
            return notFoundResponse()
          }

          if (req.method !== "GET" && req.method !== "HEAD") {
            return notFoundResponse()
          }

          if (isSharedAppRoute(url.pathname)) {
            if (!sharedIndexHtml || isAssetRequest(url.pathname)) {
              return notFoundResponse()
            }
            return sharedHtmlResponse(req, sharedIndexHtml, runtimeApiBaseUrl)
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
            return fileResponse(req, directFile, staticAssetHeaders(url.pathname))
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

function builtInAgentRoutesFor(routes: readonly PageRoute[]): BuiltInRouteManifestEntry[] {
  const projectRoutePaths = new Set(routes.map((route) => route.path))

  return builtInAgentRoutePaths
    .filter((path) => !projectRoutePaths.has(path))
    .map((path) => ({
      path,
      moduleSpecifier: builtInAgentRouteModule,
    }))
}

async function writeFileIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, "utf-8")) === content) {
      return
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error
    }
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, "utf-8")
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === "ENOENT"
  )
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
    if (isReservedSixbRoute(routePath) || routePath === customAppManifestRoute) {
      continue
    }
    routes[routePath] = getHeadRoute((request) => filePathResponse(request, filePath))
  }

  return routes
}

function reservedSixbRoutes(): BunServeRoutes {
  const handler = () => notFoundResponse()
  return {
    [internalSharedAppShellRoute]: allMethodsRoute(handler),
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

function sharedAppDevRoutes(
  bundle: Bun.HTMLBundle | null,
  internalOrigin: () => string,
  shellRoute: string,
  apiBaseUrl: string | undefined
): BunServeRoutes {
  if (!bundle) {
    const handler = () => notFoundResponse()
    return {
      "/shared": allMethodsRoute(handler),
      "/shared/*": allMethodsRoute(handler),
    }
  }

  const handler = spaHtmlRoute(internalOrigin, {
    shellRoute,
    shared: { apiBaseUrl, development: true },
  })
  return {
    "/shared": rejectMutations(handler),
    "/shared/*": rejectMutations(handler),
  }
}

function isSharedAppRoute(pathname: string): boolean {
  return pathname === "/shared" || pathname.startsWith("/shared/")
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
    readonly audience: AuthSessionAudience
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

function sharedHtmlResponse(
  request: Request,
  html: string,
  apiBaseUrl: string | undefined
): Response {
  const secured = secureSharedHtml(html, request, { apiBaseUrl, development: false })
  return new Response(request.method === "HEAD" ? null : secured.html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...secured.headers,
    },
  })
}

function secureSharedHtml(
  html: string,
  request: Request,
  options: { readonly apiBaseUrl?: string; readonly development: boolean }
): { readonly html: string; readonly headers: Record<string, string> } {
  const nonce = randomBytes(18).toString("base64url")
  const requestOrigin = new URL(request.url).origin
  let apiOrigin = requestOrigin
  try {
    apiOrigin = new URL(options.apiBaseUrl ?? requestOrigin, requestOrigin).origin
  } catch {
    // The client will surface the invalid runtime URL. Keep CSP fail-closed meanwhile.
  }
  const connectSources = ["'self'", ...(apiOrigin === requestOrigin ? [] : [apiOrigin])]
  if (options.development) connectSources.push("ws:", "wss:")
  const scriptSources = ["'self'", `'nonce-${nonce}'`]
  if (options.development) scriptSources.push("'unsafe-eval'")
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    `connect-src ${connectSources.join(" ")}`,
    "manifest-src 'none'",
  ].join("; ")

  return {
    html: html.replace(/<script(?![^>]*\snonce=)/g, `<script nonce="${nonce}"`),
    headers: {
      "cache-control": "no-store",
      "content-security-policy": contentSecurityPolicy,
      "permissions-policy": "camera=(), geolocation=(), microphone=()",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  }
}

// Bun.build emits content-hashed bundles named `chunk-<hash>.<ext>` (see buildApp).
// Their contents can never change under the same URL, so they are safe to cache
// forever — matching how Atlas serves its hashed assets. Files copied
// from `public/` keep their names across deploys and stay uncached.
const IMMUTABLE_ASSET_PATTERN = /^chunk-[a-z0-9]+\.(js|css|js\.map|css\.map)$/

function staticAssetHeaders(pathname: string): Record<string, string> {
  if (pathname === customAppManifestRoute) {
    return {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": "no-cache",
    }
  }

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

function rejectMutations(route: BunServeRoute): BunServeRoute {
  const reject = () => notFoundResponse()
  const getHead = route as unknown as {
    readonly GET: (request: Request) => Response | Promise<Response>
    readonly HEAD: (request: Request) => Response | Promise<Response>
  }
  return {
    GET: getHead.GET,
    HEAD: getHead.HEAD,
    POST: reject,
    PUT: reject,
    PATCH: reject,
    DELETE: reject,
    OPTIONS: reject,
  } as unknown as BunServeRoute
}

async function importHtmlBundle(htmlPath: string, version: number): Promise<Bun.HTMLBundle> {
  const bundleEntryPath = await prepareAppHtmlBundleEntry(htmlPath)
  const url = pathToFileURL(bundleEntryPath)
  url.searchParams.set("v", String(version))
  const htmlModule = (await import(url.href)) as { default: Bun.HTMLBundle }
  return htmlModule.default
}

function htmlBundleRoute(bundle: Bun.HTMLBundle): BunServeRoute {
  return {
    GET: bundle,
    HEAD: bundle,
  } as unknown as BunServeRoute
}

function manifestRoute(manifestPath: string): BunServeRoute {
  return getHeadRoute((request) =>
    fileResponse(request, Bun.file(manifestPath), staticAssetHeaders(customAppManifestRoute))
  )
}

function devServerInternalOrigin(host: string, port: number): string {
  if (host === "0.0.0.0") {
    return `http://127.0.0.1:${port}`
  }
  if (host === "::" || host === "[::]") {
    return `http://[::1]:${port}`
  }

  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
  return `http://${urlHost}:${port}`
}

function spaHtmlRoute(
  internalOrigin: () => string,
  options: {
    readonly shellRoute?: string
    readonly shared?: { readonly apiBaseUrl?: string; readonly development: boolean }
  } = {}
): BunServeRoute {
  return getHeadRoute(async (request) => {
    const publicUrl = new URL(request.url)
    if (publicUrl.pathname !== "/" && isAssetRequest(publicUrl.pathname)) {
      return notFoundResponse()
    }

    const url = new URL(options.shellRoute ?? internalAppShellRoute, internalOrigin())
    url.search = publicUrl.search
    const requestHeaders = new Headers(request.headers)
    for (const header of [
      "forwarded",
      "host",
      "x-forwarded-host",
      "x-forwarded-port",
      "x-forwarded-proto",
    ]) {
      requestHeaders.delete(header)
    }
    const bundleResponse = await fetch(
      new Request(url, { method: request.method, headers: requestHeaders })
    )
    const responseHeaders = new Headers(bundleResponse.headers)
    responseHeaders.delete("content-length")
    responseHeaders.delete("etag")
    let nonceSecuredHtml: string | null = null
    if (options.shared) {
      const secured = secureSharedHtml(
        request.method === "HEAD" ? "" : restoreAppStaticUrls(await bundleResponse.text()),
        request,
        options.shared
      )
      nonceSecuredHtml = secured.html
      for (const [name, value] of Object.entries(secured.headers)) {
        responseHeaders.set(name, value)
      }
    }
    if (request.method === "HEAD") {
      return new Response(null, {
        status: bundleResponse.status,
        statusText: bundleResponse.statusText,
        headers: responseHeaders,
      })
    }

    return new Response(nonceSecuredHtml ?? restoreAppStaticUrls(await bundleResponse.text()), {
      status: bundleResponse.status,
      statusText: bundleResponse.statusText,
      headers: responseHeaders,
    })
  })
}
