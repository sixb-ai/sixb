import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateAppEntry, generateRouteManifest } from "../src/codegen"
import { createParioApp } from "../src/createParioApp"
import type { PageRoute } from "../src/scanner"

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolvePromise(address.port)
      })
    })
  })
}

describe("createParioApp.start", () => {
  let tempRoot = ""

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pario-app-start-"))
    const outdir = join(tempRoot, ".pario", "dist", "app")

    await mkdir(outdir, { recursive: true })
    await writeFile(
      join(outdir, "index.html"),
      [
        "<!DOCTYPE html>",
        "<html>",
        "  <head>",
        "    <title>Fixture App</title>",
        "  </head>",
        '  <body><div id="root"></div><script type="module" src="/main.js"></script></body>',
        "</html>",
      ].join("\n")
    )
    await writeFile(join(outdir, "main.js"), "console.log('fixture app')\n")
    await writeFile(
      join(outdir, "dashboard.html"),
      "<!doctype html><html><head></head><body>Dashboard</body></html>"
    )
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("serves the built app and injects the runtime API base URL", async () => {
    const port = await getFreePort()
    const app = await createParioApp({ rootDir: tempRoot })
    const server = await app.start({
      host: "127.0.0.1",
      port,
      apiBaseUrl: "http://127.0.0.1:3000",
    })

    try {
      const rootResponse = await fetch(`http://127.0.0.1:${port}/`)
      expect(rootResponse.status).toBe(200)
      const html = await rootResponse.text()
      expect(html).toContain("Fixture App")
      expect(html).toContain(
        'window.__PARIO_RUNTIME__ = {"api":{"baseUrl":"http://127.0.0.1:3000"}};'
      )

      const routeResponse = await fetch(`http://127.0.0.1:${port}/dashboard/devices`)
      expect(routeResponse.status).toBe(200)
      expect(await routeResponse.text()).toContain('<div id="root"></div>')

      const assetResponse = await fetch(`http://127.0.0.1:${port}/main.js`)
      expect(assetResponse.status).toBe(200)
      expect(await assetResponse.text()).toContain("fixture app")

      const missingAssetResponse = await fetch(`http://127.0.0.1:${port}/missing.js`)
      expect(missingAssetResponse.status).toBe(404)

      const missingHtmlResponse = await fetch(`http://127.0.0.1:${port}/missing.html`)
      expect(missingHtmlResponse.status).toBe(404)

      const mutationResponse = await fetch(`http://127.0.0.1:${port}/dashboard/devices`, {
        method: "POST",
      })
      expect(mutationResponse.status).toBe(405)
    } finally {
      await server.stop()
    }
  })

  test("exposes a production mount for same-origin server serving", async () => {
    const app = await createParioApp({ rootDir: tempRoot })
    const mount = await app.createProductionMount()

    const indexHtml = await mount.indexHtml()
    const routeHtml = await mount.html("/dashboard.html")
    const asset = await mount.asset("/main.js")
    const htmlAsAsset = await mount.asset("/dashboard.html")
    const missingAsset = await mount.asset("/missing.js")

    expect(mount.kind).toBe("production")
    expect(indexHtml).toContain("Fixture App")
    expect(routeHtml).toContain("Dashboard")
    expect(asset?.cacheControl).toBe("public, max-age=31536000, immutable")
    expect(htmlAsAsset).toBeNull()
    expect(missingAsset).toBeNull()
  })
})

describe("createParioApp generated apps", () => {
  let tempRoot = ""

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pario-app-generated-"))
    const appDir = join(tempRoot, "app")
    await mkdir(appDir, { recursive: true })
    await writeFile(
      join(appDir, "page.tsx"),
      [
        "export default function Page() {",
        '  return <main data-testid="home">Home</main>',
        "}",
      ].join("\n")
    )
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("generates runtime CSRF handling for custom apps", async () => {
    const app = await createParioApp({ rootDir: tempRoot })
    const mount = await app.createDevMount()

    try {
      const generatedMain = await readFile(
        join(tempRoot, ".pario", "generated", "main.tsx"),
        "utf-8"
      )
      expect(generatedMain).toContain("__PARIO_RUNTIME__")
      expect(generatedMain).toContain("x-pario-csrf")
      expect(generatedMain).toContain("resolveCsrfCookieName")
      expect(generatedMain).toContain("client.interceptors.request.use")
    } finally {
      await mount.stop?.()
    }
  })

  test("exposes constrained development mount paths for same-origin serving", async () => {
    const app = await createParioApp({ rootDir: tempRoot })
    const mount = await app.createDevMount()

    try {
      expect(mount.kind).toBe("development")
      expect(mount.origin.protocol).toBe("http:")
      expect(mount.hmrWebSocketPaths).toContainEqual({ kind: "exact", path: "/_bun/hmr" })
      expect(mount.publicProxyPaths).toContainEqual({ kind: "prefix", path: "/_bun/" })
      expect(mount.publicProxyPaths).toContainEqual({
        kind: "prefix",
        path: "/.pario/generated/",
      })
      expect(mount.publicProxyPaths).toContainEqual({ kind: "prefix", path: "/app/" })
    } finally {
      await mount.stop?.()
    }
  })

  test("does not rewrite unchanged generated files during development refreshes", async () => {
    const appDir = join(tempRoot, "app")
    const generatedDir = join(tempRoot, ".pario", "generated")
    const routes: PageRoute[] = [
      {
        path: "/",
        filePath: join(appDir, "page.tsx"),
        relativePath: "page.tsx",
      },
    ]

    await generateRouteManifest(routes, generatedDir)
    const { htmlPath, mainPath } = await generateAppEntry(tempRoot, generatedDir, { appDir })
    const routesPath = join(generatedDir, "routes.ts")
    const stableTime = new Date("2024-01-01T00:00:00.000Z")

    await utimes(htmlPath, stableTime, stableTime)
    await utimes(mainPath, stableTime, stableTime)
    await utimes(routesPath, stableTime, stableTime)

    await generateRouteManifest(routes, generatedDir)
    await generateAppEntry(tempRoot, generatedDir, { appDir })

    expect((await stat(htmlPath)).mtimeMs).toBe(stableTime.getTime())
    expect((await stat(mainPath)).mtimeMs).toBe(stableTime.getTime())
    expect((await stat(routesPath)).mtimeMs).toBe(stableTime.getTime())
  })
})
