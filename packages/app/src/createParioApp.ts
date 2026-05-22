import { cp } from "node:fs/promises"
import { join, resolve } from "node:path"
import { type BuildAppResult, buildApp } from "./build"
import { generateAppEntry, generateRouteManifest } from "./codegen"
import { type PageRoute, scanPages } from "./scanner"
import {
  createDevelopmentMount,
  type ParioAppDevServer,
  startDevelopmentServer,
} from "./surfaces/devSurface"
import { pathExists } from "./surfaces/paths"
import { createProductionMount } from "./surfaces/productionSurface"
import type {
  CustomAppDevelopmentMount,
  CustomAppMount,
  CustomAppProductionMount,
} from "./surfaces/types"

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

export interface ParioAppInstance {
  scanRoutes(): Promise<PageRoute[]>
  hasRoutes(): Promise<boolean>
  createDevMount(options?: ParioAppDevOptions): Promise<CustomAppDevelopmentMount>
  createProductionMount(options?: ParioAppStartOptions): Promise<CustomAppProductionMount>
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

    async createDevMount(devOptions: ParioAppDevOptions = {}) {
      return await createDevelopmentMount({
        rootDir,
        appDir,
        generatedDir,
        publicDir,
        host: devOptions.host,
        port: devOptions.port,
        prepareGeneratedApp,
      })
    },

    async createProductionMount(startOptions: ParioAppStartOptions = {}) {
      return await createProductionMount({
        outdir: resolve(rootDir, startOptions.outdir ?? join(".pario", "dist", "app")),
        apiBaseUrl: startOptions.apiBaseUrl,
      })
    },

    async dev(devOptions: ParioAppDevOptions = {}) {
      return await startDevelopmentServer({
        rootDir,
        appDir,
        generatedDir,
        publicDir,
        host: devOptions.host,
        port: devOptions.port,
        prepareGeneratedApp,
      })
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
      const mount = await createProductionMount({
        outdir: resolve(rootDir, startOptions.outdir ?? join(".pario", "dist", "app")),
        apiBaseUrl: startOptions.apiBaseUrl,
      })
      const server = Bun.serve({
        port,
        hostname: host,
        development: false,
        async fetch(req) {
          return await standaloneProductionResponse(mount, req)
        },
      })

      const displayHost = host === "0.0.0.0" ? "localhost" : host

      return {
        host,
        port,
        url: `http://${displayHost}:${port}`,
        async stop() {
          await mount.stop?.()
          server.stop(true)
        },
      }
    },
  }
}

async function standaloneProductionResponse(
  mount: Extract<CustomAppMount, { kind: "production" }>,
  request: Request
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    })
  }

  const url = new URL(request.url)
  const asset = await mount.asset(url.pathname)
  if (asset) {
    const headers = new Headers()
    if (asset.contentType) headers.set("content-type", asset.contentType)
    if (asset.cacheControl) headers.set("cache-control", asset.cacheControl)
    return new Response(request.method === "HEAD" ? null : asset.body, { headers })
  }

  if (
    /\.[^/]+$/.test(url.pathname.split("/").pop() ?? "") &&
    !url.pathname.toLowerCase().endsWith(".html")
  ) {
    return new Response("Not Found", { status: 404 })
  }

  if (url.pathname.toLowerCase().endsWith(".html")) {
    const html = await mount.html(url.pathname)
    if (!html) {
      return new Response("Not Found", { status: 404 })
    }

    return new Response(request.method === "HEAD" ? null : html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  }

  const html = url.pathname === "/" ? await mount.indexHtml() : await mount.html(url.pathname)
  return new Response(request.method === "HEAD" ? null : (html ?? (await mount.indexHtml())), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}
