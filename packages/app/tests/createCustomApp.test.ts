import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateAppEntry } from "../src/codegen"
import { createCustomApp } from "../src/createCustomApp"

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

describe("createCustomApp.start", () => {
  let tempRoot = ""

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sixb-app-start-"))
    const outdir = join(tempRoot, ".sixb", "dist", "app")

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
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("serves the built app and injects the runtime API base URL", async () => {
    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot, audience: "app" })
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
      expect(html).toContain('"api":{"baseUrl":"http://127.0.0.1:3000"}')
      expect(html).toContain('"auth":{"audience":"app","enabled":true}')

      const routeResponse = await fetch(`http://127.0.0.1:${port}/dashboard/devices`)
      expect(routeResponse.status).toBe(200)
      expect(await routeResponse.text()).toContain('<div id="root"></div>')

      const assetResponse = await fetch(`http://127.0.0.1:${port}/main.js`)
      expect(assetResponse.status).toBe(200)
      expect(await assetResponse.text()).toContain("fixture app")

      const missingAssetResponse = await fetch(`http://127.0.0.1:${port}/missing.js`)
      expect(missingAssetResponse.status).toBe(404)

      const apiResponse = await fetch(`http://127.0.0.1:${port}/api/project`)
      expect(apiResponse.status).toBe(404)

      const mutationResponse = await fetch(`http://127.0.0.1:${port}/dashboard/devices`, {
        method: "POST",
      })
      expect(mutationResponse.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("falls back to the SPA shell for deep routes with encoded slashes and dots", async () => {
    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot, audience: "app" })
    const server = await app.start({
      host: "127.0.0.1",
      port,
      apiBaseUrl: "http://127.0.0.1:3000",
    })

    try {
      // Regression: an object id with percent-encoded slashes (`%2F`) and a dotted
      // segment (the IP `10.75.35.6`) lives inside a single path segment. On a hard
      // refresh this must serve the SPA shell, not 404 as a "missing asset".
      const deepRoute = "/point/point%3Asetty%3Asetty%2Fsetty%2F10.75.35.6-708112%2Fdevice%2F708112"
      const response = await fetch(`http://127.0.0.1:${port}${deepRoute}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<div id="root"></div>')

      // A missing asset with a real extension still 404s.
      const missingCss = await fetch(`http://127.0.0.1:${port}/assets/app.css`)
      expect(missingCss.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("injects disabled auth state for public local apps", async () => {
    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot, audience: "app", authEnabled: false })
    const server = await app.start({
      host: "127.0.0.1",
      port,
      apiBaseUrl: "http://127.0.0.1:3000",
    })

    try {
      const rootResponse = await fetch(`http://127.0.0.1:${port}/`)
      expect(rootResponse.status).toBe(200)
      expect(await rootResponse.text()).toContain('"auth":{"audience":"app","enabled":false}')
    } finally {
      await server.stop()
    }
  })
})

describe("createCustomApp.dev", () => {
  let tempRoot = ""

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "sixb-app-dev-"))
    const appDir = join(tempRoot, "app")
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, "page.tsx"), "export default function Page() { return null }\n")
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  test("keeps Sixb API-owned routes out of the dev app origin", async () => {
    const port = await getFreePort()
    const app = await createCustomApp({
      rootDir: tempRoot,
      apiBaseUrl: "http://127.0.0.1:3000",
    })
    const server = await app.dev({
      host: "127.0.0.1",
      port,
    })

    try {
      const apiResponse = await fetch(`http://127.0.0.1:${port}/api/project`)
      const authResponse = await fetch(`http://127.0.0.1:${port}/auth/sign-in`)
      const mutationResponse = await fetch(`http://127.0.0.1:${port}/devices`, {
        method: "POST",
      })

      expect(apiResponse.status).toBe(404)
      expect(authResponse.status).toBe(404)
      expect(mutationResponse.status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("generates a structural shell without framework visual styles", async () => {
    const { htmlPath } = await generateAppEntry(tempRoot, join(tempRoot, ".sixb", "generated"))
    const html = await readFile(htmlPath, "utf-8")

    expect(html).toContain("box-sizing: border-box")
    expect(html).toContain("margin: 0")
    expect(html).toContain("min-height: 100vh")
    expect(html).not.toContain("theme-color")
    expect(html).not.toContain("font-family")
    expect(html).not.toContain("background")
    expect(html).not.toContain("color:")
    expect(html).not.toContain("#05070c")
    expect(html).not.toContain("#0b1222")
    expect(html).not.toContain("radial-gradient")
  })
})
