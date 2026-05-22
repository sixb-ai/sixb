import { watch } from "node:fs"
import { access, cp } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, resolve } from "node:path"
import { type BuildAppResult, buildApp } from "./build"
import { generateAppEntry, generateRouteManifest } from "./codegen"
import { type PageRoute, scanPages } from "./scanner"

export interface CreateParioAppOptions {
  rootDir: string
  appDir?: string
  generatedDir?: string
  publicDir?: string
  apiBaseUrl?: string
}

export interface ParioAppDevOptions {
  host?: string
  port?: number
}

export interface ParioAppBuildOptions {
  outdir?: string
}

export interface ParioAppStartOptions {
  host?: string
  port?: number
  outdir?: string
  apiBaseUrl?: string
}

export interface ParioAppDevServer {
  host: string
  port: number
  url: string
  stop(): Promise<void>
}

export interface ParioAppInstance {
  scanRoutes(): Promise<PageRoute[]>
  hasRoutes(): Promise<boolean>
  dev(options?: ParioAppDevOptions): Promise<ParioAppDevServer>
  build(options?: ParioAppBuildOptions): Promise<BuildAppResult>
  start(options?: ParioAppStartOptions): Promise<ParioAppDevServer>
}

export async function createParioApp(options: CreateParioAppOptions): Promise<ParioAppInstance> {
  const rootDir = resolve(options.rootDir)
  const appDir = options.appDir ? resolve(rootDir, options.appDir) : resolve(rootDir, "app")
  const generatedDir = resolve(rootDir, options.generatedDir ?? join(".pario", "generated"))
  const publicDir = options.publicDir
    ? resolve(rootDir, options.publicDir)
    : resolve(appDir, "public")
  const apiBaseUrl = options.apiBaseUrl

  async function scanRoutes(): Promise<PageRoute[]> {
    if (!(await pathExists(appDir))) {
      return []
    }

    return await scanPages(appDir)
  }

  async function prepareGeneratedApp(): Promise<{ htmlPath: string; routes: PageRoute[] }> {
    const routes = await scanRoutes()
    if (routes.length === 0) {
      throw new Error(`[ParioApp] No app routes found in ${appDir}`)
    }

    await generateRouteManifest(routes, generatedDir)
    const { htmlPath } = await generateAppEntry(rootDir, generatedDir, {
      apiBaseUrl,
      appDir,
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

    async dev(devOptions: ParioAppDevOptions = {}) {
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
          "/": htmlModule.default,
          "/*": htmlModule.default,
        },
      } as Parameters<typeof Bun.serve>[0])

      const watcher = watch(appDir, { recursive: true }, async (_eventType, filename) => {
        if (!filename) return
        if (!filename.endsWith(".tsx") && !filename.endsWith(".ts")) return

        try {
          await prepareGeneratedApp()
        } catch {
          // Ignore transient rebuild errors during dev; Bun will keep serving the last good build.
        }
      })

      const displayHost = host === "0.0.0.0" ? "localhost" : host

      return {
        host,
        port,
        url: `http://${displayHost}:${port}`,
        async stop() {
          watcher.close()
          server.stop(true)
        },
      }
    },

    async build(buildOptions: ParioAppBuildOptions = {}) {
      const outdir = resolve(rootDir, buildOptions.outdir ?? join(".pario", "dist", "app"))
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

    async start(startOptions: ParioAppStartOptions = {}) {
      const host = startOptions.host ?? "0.0.0.0"
      const port = startOptions.port ?? 3001
      const outdir = resolve(rootDir, startOptions.outdir ?? join(".pario", "dist", "app"))
      const indexPath = join(outdir, "index.html")

      if (!(await pathExists(indexPath))) {
        throw new Error(`[ParioApp] No built app found in ${outdir}`)
      }

      const indexHtml = injectApiBaseUrl(await Bun.file(indexPath).text(), startOptions.apiBaseUrl)
      const server = Bun.serve({
        port,
        hostname: host,
        development: false,
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === "/" || url.pathname === "") {
            return htmlResponse(indexHtml)
          }

          const resolvedPath = resolveStaticPath(outdir, url.pathname)
          if (!resolvedPath) {
            return new Response("Not Found", { status: 404 })
          }

          const directFile = Bun.file(resolvedPath)
          if (await directFile.exists()) {
            return new Response(directFile)
          }

          if (isAssetRequest(url.pathname)) {
            return new Response("Not Found", { status: 404 })
          }

          const htmlFile = Bun.file(`${resolvedPath}.html`)
          if (await htmlFile.exists()) {
            return new Response(htmlFile)
          }

          const nestedIndexFile = Bun.file(join(resolvedPath, "index.html"))
          if (await nestedIndexFile.exists()) {
            return new Response(nestedIndexFile)
          }

          return htmlResponse(indexHtml)
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

async function createPublicRoutes(
  publicDir: string
): Promise<Record<string, () => Response | Promise<Response>>> {
  const files = new Bun.Glob("**/*").scan({
    cwd: publicDir,
    absolute: true,
    onlyFiles: true,
  })
  const routes: Record<string, () => Response | Promise<Response>> = {}

  for await (const filePath of files) {
    const routePath = `/${filePath
      .slice(publicDir.length + 1)
      .split("\\")
      .join("/")}`
    routes[routePath] = () => new Response(Bun.file(filePath))
  }

  return routes
}

function isAssetRequest(pathname: string): boolean {
  const lastSegment = pathname.split("/").pop() ?? ""
  return /\.[^/]+$/.test(lastSegment)
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

function injectApiBaseUrl(html: string, apiBaseUrl?: string): string {
  if (!apiBaseUrl) {
    return html
  }

  const script = `<script>window.__PARIO_API_BASE_URL__ = ${JSON.stringify(apiBaseUrl)};</script>`
  if (html.includes("</head>")) {
    return html.replace("</head>", `  ${script}\n  </head>`)
  }

  return `${script}\n${html}`
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  })
}
