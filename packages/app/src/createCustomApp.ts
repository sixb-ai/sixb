import { watch } from "node:fs"
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { AuthSessionAudience } from "@sixb/core"
import {
  type BuildAppResult,
  buildApp,
  buildAuthExperience,
  prepareAppHtmlBundleEntry,
  restoreAppStaticUrls,
} from "./build"
import {
  type BuiltInRouteManifestEntry,
  generateAppEntry,
  generateAuthExperienceEntry,
  generateRouteManifest,
} from "./codegen"
import { renderCustomAppRuntimeScript } from "./runtime"
import { type PageRoute, routePatternKey, scanAppRoutes } from "./scanner"
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

export interface CustomAuthExperienceBuildOptions {
  outdir?: string
}

export interface CustomAuthExperienceBuildResult {
  readonly outdir: string
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
  prepareAuthExperience(
    options?: CustomAuthExperienceBuildOptions
  ): Promise<CustomAuthExperienceBuildResult | null>
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
    return [...(await scanAppRoutes(appDir)).pages]
  }

  let tailwindCompiler: TailwindCssCompiler | null = null
  let tailwindCompilerKey: string | null = null
  let authTailwindCompiler: TailwindCssCompiler | null = null
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
    mainPath: string
    manifestPath: string
    routes: PageRoute[]
  }> {
    const discovery = await scanAppRoutes(appDir)
    const routes = [...discovery.pages]
    if (routes.length === 0) {
      throw new Error(`[SixbCustomApp] No app routes found in ${appDir}`)
    }

    const builtInRoutes = agentRoutesEnabled ? builtInAgentRoutesFor(routes) : []
    const stylesheets = await prepareStylesheets(builtInRoutes)
    await generateRouteManifest(routes, generatedDir, {
      builtInRoutes,
      layouts: discovery.layouts,
    })
    const { htmlPath, mainPath, manifestPath } = await generateAppEntry(rootDir, generatedDir, {
      apiBaseUrl,
      audience,
      authEnabled,
      appDir,
      publicDir,
      frameworkStylesheetPaths: stylesheets.frameworkStylesheetPaths,
      stylesheetPath: stylesheets.stylesheetPath,
    })
    return { htmlPath, mainPath, manifestPath, routes }
  }

  async function prepareAuthExperience(
    authOptions: CustomAuthExperienceBuildOptions = {}
  ): Promise<CustomAuthExperienceBuildResult | null> {
    const outdir = authOptions.outdir
      ? resolve(rootDir, authOptions.outdir)
      : join(generatedDir, "auth")
    if (!(await pathExists(join(appDir, "auth.tsx")))) {
      await rm(outdir, { recursive: true, force: true })
      return null
    }

    const stylesheet = await resolveCustomAppStylesheet({ appDir, generatedDir, rootDir })
    let stylesheetPath: string | null
    if (stylesheet.kind === "none") {
      stylesheetPath = null
    } else if (stylesheet.kind === "static") {
      stylesheetPath = stylesheet.path
    } else {
      const outputPath = join(generatedDir, "auth.css")
      authTailwindCompiler ??= createTailwindCssCompiler({
        inputPath: stylesheet.sourcePath,
        outputPath,
        cwd: appDir,
        resolveFrom: rootDir,
        label: "[SixbCustomApp]",
      })
      await authTailwindCompiler.compile()
      stylesheetPath = outputPath
    }

    const entry = await generateAuthExperienceEntry(rootDir, generatedDir, {
      appDir,
      publicDir,
      stylesheetPath,
    })
    if (!entry) {
      return null
    }

    const result = await buildAuthExperience({
      entryPath: entry.htmlPath,
      scriptEntryPath: entry.mainPath,
      outdir,
    })
    if (!result.success) {
      throw new Error(
        `[SixbCustomApp] Failed to build the auth experience: ${(result.logs ?? []).join("\n")}`
      )
    }
    return { outdir: result.outdir }
  }

  return {
    async scanRoutes() {
      return await scanRoutes()
    },

    async hasRoutes() {
      const routes = await scanRoutes()
      return routes.length > 0
    },

    async prepareAuthExperience(options) {
      return await prepareAuthExperience(options)
    },

    async dev(devOptions: CustomAppDevOptions = {}) {
      const host = devOptions.host ?? "0.0.0.0"
      const port = devOptions.port ?? 3001
      const { htmlPath, manifestPath } = await prepareGeneratedApp()
      await prepareAuthExperience()
      let htmlImportVersion = 0
      let htmlBundle = await importHtmlBundle(htmlPath, htmlImportVersion)
      const publicRoutes = (await pathExists(publicDir)) ? await createPublicRoutes(publicDir) : {}
      let internalOrigin = ""
      const serveOptions = (bundle: Bun.HTMLBundle) =>
        ({
          port,
          hostname: host,
          development: true,
          routes: {
            ...publicRoutes,
            ...reservedSixbRoutes(),
            [customAppManifestRoute]: manifestRoute(manifestPath),
            [internalAppShellRoute]: htmlBundleRoute(bundle),
            "/": spaHtmlRoute(() => internalOrigin),
            "/*": spaHtmlRoute(() => internalOrigin),
          },
        }) as Parameters<typeof Bun.serve>[0]
      const server = Bun.serve(serveOptions(htmlBundle))
      internalOrigin = devServerInternalOrigin(host, server.port ?? port)

      // .ts/.tsx edits can change Tailwind's scanned classes and .css edits
      // change the stylesheet source, so both regenerate the entry and
      // recompile CSS. Debounced so a burst of saves builds once.
      let rebuildTimer: ReturnType<typeof setTimeout> | null = null
      let rebuildChain: Promise<void> = Promise.resolve()
      const enqueueRebuild = () => {
        rebuildChain = rebuildChain
          .then(async () => {
            const { htmlPath: nextHtmlPath } = await prepareGeneratedApp()
            await prepareAuthExperience()
            htmlImportVersion++
            htmlBundle = await importHtmlBundle(nextHtmlPath, htmlImportVersion)
            server.reload(serveOptions(htmlBundle))
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
          await authTailwindCompiler?.stop()
          await builtInAgentCssCompiler?.stop()
          server.stop(true)
        },
      }
    },

    async build(buildOptions: CustomAppBuildOptions = {}) {
      const outdir = resolve(rootDir, buildOptions.outdir ?? join(".sixb", "dist", "app"))
      const { htmlPath, mainPath, manifestPath } = await prepareGeneratedApp()
      const result = await buildApp({
        entryPath: htmlPath,
        scriptEntryPath: mainPath,
        manifestPath,
        outdir,
      })

      if (result.success) {
        await prepareAuthExperience({ outdir: join(outdir, "auth") })
      }

      if (result.success && (await pathExists(publicDir))) {
        await cp(publicDir, outdir, {
          recursive: true,
          force: true,
          filter: (source) => {
            const resolvedSource = resolve(source)
            return (
              resolvedSource !== join(publicDir, "app.webmanifest") &&
              resolvedSource !== join(publicDir, "auth")
            )
          },
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
            return staticFileResponse(req, resolvedPath, staticAssetHeaders(url.pathname))
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
  const projectRoutePatterns = new Set(routes.map((route) => routePatternKey(route.path)))

  return builtInAgentRoutePaths
    .filter((path) => !projectRoutePatterns.has(routePatternKey(path)))
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

// buildApp emits content-hashed entry, chunk, and asset names. Their contents can never change
// under the same URL, so they are safe to cache forever. Files copied from `public/` keep their
// names across deploys and stay uncached.
const IMMUTABLE_ASSET_PATTERN =
  /^(?:(?:app|chunk)-[a-z0-9]+|(?:chunk|asset)-.+-[a-z0-9]+)\.[a-z0-9]+(?:\.map)?$/

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

async function staticFileResponse(
  request: Request,
  path: string,
  headers: Record<string, string>
): Promise<Response> {
  const responseHeaders = new Headers(headers)
  const originalFile = Bun.file(path)
  let responseFile = originalFile

  if (isPrecompressedAsset(path)) {
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

function isPrecompressedAsset(path: string): boolean {
  return path.endsWith(".js") || path.endsWith(".css")
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

function spaHtmlRoute(internalOrigin: () => string): BunServeRoute {
  return getHeadRoute(async (request) => {
    const publicUrl = new URL(request.url)
    if (publicUrl.pathname !== "/" && isAssetRequest(publicUrl.pathname)) {
      return notFoundResponse()
    }

    const url = new URL(internalAppShellRoute, internalOrigin())
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
    if (request.method === "HEAD") {
      return new Response(null, {
        status: bundleResponse.status,
        statusText: bundleResponse.statusText,
        headers: responseHeaders,
      })
    }

    return new Response(restoreAppStaticUrls(await bundleResponse.text()), {
      status: bundleResponse.status,
      statusText: bundleResponse.statusText,
      headers: responseHeaders,
    })
  })
}
