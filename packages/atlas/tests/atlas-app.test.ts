import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { createAtlasApp } from "../src"

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
    })

    try {
      const baseUrl = `http://127.0.0.1:${port}`
      const rootResponse = await fetch(`${baseUrl}/`)
      const routeResponse = await fetch(`${baseUrl}/devices`)

      expect(rootResponse.status).toBe(200)
      expect(routeResponse.status).toBe(200)

      const html = await rootResponse.text()
      const scriptPath = extractAssetPath(html, "script")
      const stylesheetPath = extractAssetPath(html, "stylesheet")

      expect(html).toContain('"api":{"baseUrl":"http://api.localhost"}')
      expect(html).toContain('"auth":{"audience":"atlas","enabled":true}')
      expect(scriptPath).toMatch(/^\/__pario\/main-[^.]+\.js$/)
      expect(stylesheetPath).toMatch(/^\/__pario\/main-[^.]+\.css$/)
      expect(html).toContain('<div id="root"></div>')

      for (const assetPath of [scriptPath, stylesheetPath]) {
        const assetResponse = await fetch(`${baseUrl}${assetPath}`)
        expect(assetResponse.status).toBe(200)
        expect(assetResponse.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable"
        )
      }

      const stableAssetResponse = await fetch(`${baseUrl}/__pario/main.js`)
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
    })

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('"auth":{"audience":"atlas","enabled":false}')
    } finally {
      await server.stop()
    }
  })

  test("does not serve Pario API-owned routes from the Atlas origin", async () => {
    const port = await getFreePort()
    const atlas = createAtlasApp({
      apiBaseUrl: "http://api.localhost",
      audience: "atlas",
    })
    const server = await atlas.start({
      host: "127.0.0.1",
      port,
      development: false,
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
