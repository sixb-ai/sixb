import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAtlasAssets, createAtlasApp } from "../src"

let assetsRoot: string
let assetsOutdir: string

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const server = createServer() as ReturnType<typeof createServer> & {
      on(event: string, listener: (error: Error) => void): void
    }

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

describe("createAtlasApp", () => {
  beforeAll(async () => {
    assetsRoot = await mkdtemp(join(tmpdir(), "sixb-atlas-assets-"))
    assetsOutdir = join(assetsRoot, "atlas")
    await buildAtlasAssets({ outdir: assetsOutdir })
  })

  afterAll(async () => {
    if (assetsRoot) {
      await rm(assetsRoot, { recursive: true, force: true })
    }
  })

  test("serves the public Atlas shell with API runtime config", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
    })
    const server = await atlas.start({
      host: "127.0.0.1",
      port,
      development: false,
      outdir: assetsOutdir,
    })

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const rootResponse = await fetch(`${baseUrl}/`)
      const routeResponse = await fetch(`${baseUrl}/devices`)
      const dottedRouteResponse = await fetch(`${baseUrl}/datasets/raw.ace.sites`)

      expect(rootResponse.status).toBe(200)
      expect(routeResponse.status).toBe(200)
      expect(dottedRouteResponse.status).toBe(200)

      const html = await rootResponse.text()
      const scriptPath = extractAssetPath(html, "script")
      const stylesheetPath = extractAssetPath(html, "stylesheet")
      const dottedRouteHtml = await dottedRouteResponse.text()

      expect(html).toContain('"api":{"baseUrl":"http://api.localhost"}')
      expect(html).toContain('"auth":{"audience":"atlas","enabled":true}')
      // The entry is named `atlas-*` and split chunks `chunk-*`, so the shell can never point at a
      // chunk. Naming both `[name]-[hash]` made `main.tsx` and its 47 shared chunks indistinguishable.
      expect(scriptPath).toMatch(/^\/__sixb\/atlas-[^.]+\.js$/)
      expect(stylesheetPath).toMatch(/^\/__sixb\/atlas-[^.]+\.css$/)
      expect(html).toContain('<div id="root"></div>')
      expect(dottedRouteHtml).toContain('<div id="root"></div>')

      for (const assetPath of [scriptPath, stylesheetPath]) {
        const assetResponse = await fetch(`${baseUrl}${assetPath}`)
        expect(assetResponse.status).toBe(200)
        expect(assetResponse.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable"
        )
      }

      const stableAssetResponse = await fetch(`${baseUrl}/__sixb/main.js`)
      expect(stableAssetResponse.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("serves disabled auth state in the Atlas shell", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
      authEnabled: false,
    })
    const server = await atlas.start({
      host: "127.0.0.1",
      port,
      development: false,
      outdir: assetsOutdir,
    })

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('"auth":{"audience":"atlas","enabled":false}')
    } finally {
      await server.stop()
    }
  })

  test("serves the development Atlas shell with Bun's HTML bundle", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
      authEnabled: false,
    })
    const server = await atlas.start({
      host: "127.0.0.1",
      port,
      development: true,
    })

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const rootResponse = await fetch(`${baseUrl}/`)
      const routeResponse = await fetch(`${baseUrl}/devices`)
      const faviconResponse = await fetch(`${baseUrl}/favicon.svg`)
      const runtimeResponse = await fetch(`${baseUrl}/__sixb/runtime.json`)
      const apiResponse = await fetch(`${baseUrl}/api/project`)

      expect(rootResponse.status).toBe(200)
      expect(routeResponse.status).toBe(200)
      expect(faviconResponse.status).toBe(200)
      expect(runtimeResponse.status).toBe(200)
      expect(await runtimeResponse.json()).toEqual({
        api: { baseUrl: "http://api.localhost" },
        auth: { audience: "atlas", enabled: false },
      })
      expect(apiResponse.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("does not serve Sixb API-owned routes from the Atlas origin", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
    })
    const server = await atlas.start({
      host: "127.0.0.1",
      port,
      development: false,
      outdir: assetsOutdir,
    })

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      for (const path of ["/api/project", "/auth/sign-in", "/ws/events", "/docs"]) {
        const response = await fetch(`${baseUrl}${path}`)
        expect(response.status).toBe(404)
      }
    } finally {
      await server.stop()
    }
  })

  test("fails clearly when production assets are missing", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
    })

    await expect(
      atlas.start({
        host: "127.0.0.1",
        port,
        development: false,
        outdir: join(assetsRoot, "missing"),
      })
    ).rejects.toThrow("Run `sixb build`")
  })
})

function extractAssetPath(html: string, kind: "script" | "stylesheet"): string {
  const pattern =
    kind === "script"
      ? /<script type="module" src="([^"]+)"><\/script>/
      : /<link rel="stylesheet" href="([^"]+)" \/>/
  const match = html.match(pattern)
  if (!match?.[1]) {
    throw new Error(`Could not find Atlas ${kind} asset path in shell HTML.`)
  }
  return match[1]
}
