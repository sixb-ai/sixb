import { afterEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createCustomApp } from "@pario/app"

const acmeRoot = dirname(dirname(fileURLToPath(import.meta.url)))

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

describe("Acme review app", () => {
  let tempRoot = ""

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
      tempRoot = ""
    }
  })

  test("serves the workflow intervention review path in the custom app", async () => {
    tempRoot = join(acmeRoot, ".pario", "review-app-test")
    const generatedDir = join(tempRoot, "generated")
    const app = await createCustomApp({
      rootDir: acmeRoot,
      generatedDir,
      apiBaseUrl: "http://127.0.0.1:3000",
      authEnabled: false,
    })

    const routes = await app.scanRoutes()
    expect(routes.map((route) => route.path).sort()).toEqual(["/", "/review/:interventionId"])

    const port = await getFreePort()
    const server = await app.dev({
      host: "127.0.0.1",
      port,
    })

    try {
      const response = await fetch(`http://127.0.0.1:${port}/review/workflow-intervention-1`)
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).toContain('<div id="root"></div>')
      expect(html).toContain('"auth":{"audience":"app","enabled":false}')
    } finally {
      await server.stop()
    }
  })
})
