import { describe, expect, test } from "bun:test"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createCustomApp } from "@sixb/app"

const acmeRoot = dirname(dirname(fileURLToPath(import.meta.url)))

describe("Acme review app", () => {
  test("declares the workflow intervention review routes", async () => {
    const app = await createCustomApp({
      rootDir: acmeRoot,
      apiBaseUrl: "http://127.0.0.1:3000",
      authEnabled: false,
    })

    const routes = await app.scanRoutes()
    expect(routes.map((route) => route.path).sort()).toEqual(["/", "/review/:interventionId"])
  })
})
