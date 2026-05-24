import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { createAtlasApp } from "../src"

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
      const assetResponse = await fetch(`${baseUrl}/__pario/main.js`)

      expect(rootResponse.status).toBe(200)
      expect(routeResponse.status).toBe(200)
      expect(assetResponse.status).toBe(200)

      const html = await rootResponse.text()
      expect(html).toContain('"api":{"baseUrl":"http://api.localhost"}')
      expect(html).toContain('"auth":{"audience":"atlas"}')
      expect(html).toContain('<div id="root"></div>')
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
