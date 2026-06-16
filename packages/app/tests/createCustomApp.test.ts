import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateAppEntry, generateRouteManifest } from "../src/codegen"
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

function wait(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function mtimes(paths: readonly string[]): Promise<readonly number[]> {
  return await Promise.all(paths.map(async (path) => (await stat(path)).mtimeMs))
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

  test("serves hashed build chunks with immutable cache headers", async () => {
    const outdir = join(tempRoot, ".sixb", "dist", "app")
    await writeFile(join(outdir, "chunk-ab12cd34.js"), "console.log('chunk')\n")
    await writeFile(join(outdir, "chunk-ab12cd34.css"), "body{}\n")

    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot, audience: "app" })
    const server = await app.start({
      host: "127.0.0.1",
      port,
      apiBaseUrl: "http://127.0.0.1:3000",
    })

    try {
      const immutable = "public, max-age=31536000, immutable"
      const chunkJs = await fetch(`http://127.0.0.1:${port}/chunk-ab12cd34.js`)
      expect(chunkJs.status).toBe(200)
      expect(chunkJs.headers.get("cache-control")).toBe(immutable)

      const chunkCss = await fetch(`http://127.0.0.1:${port}/chunk-ab12cd34.css`)
      expect(chunkCss.headers.get("cache-control")).toBe(immutable)

      // Non-hashed files (public/ copies) and the SPA shell stay uncached.
      const mainJs = await fetch(`http://127.0.0.1:${port}/main.js`)
      expect(mainJs.status).toBe(200)
      expect(mainJs.headers.get("cache-control")).toBeNull()

      const shell = await fetch(`http://127.0.0.1:${port}/`)
      expect(shell.headers.get("cache-control")).toBe("no-store")
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

  test("generates an eager entry with no lazy routes or Suspense gap", async () => {
    const { mainPath } = await generateAppEntry(tempRoot, join(tempRoot, ".sixb", "generated"))
    const main = await readFile(mainPath, "utf-8")

    // Routes render synchronously after auth — no Suspense fallback frame.
    expect(main).not.toContain("lazy(")
    expect(main).not.toContain("Suspense")
    expect(main).toContain("requireSixbBrowserAuthSession(runtimeConfig")
  })

  test("route manifest statically imports every page", async () => {
    const generatedDir = join(tempRoot, ".sixb", "generated")
    const manifestPath = await generateRouteManifest(
      [
        {
          path: "/",
          filePath: join(tempRoot, "app", "page.tsx"),
          relativePath: "page.tsx",
        },
        {
          path: "/devices/:id",
          filePath: join(tempRoot, "app", "devices", "[id]", "page.tsx"),
          relativePath: "devices/[id]/page.tsx",
        },
      ],
      generatedDir
    )
    const manifest = await readFile(manifestPath, "utf-8")

    expect(manifest).toContain('import Page0 from "../../app/page.tsx"')
    expect(manifest).toContain('import Page1 from "../../app/devices/[id]/page.tsx"')
    expect(manifest).toContain('{ path: "/", component: Page0 },')
    expect(manifest).toContain('{ path: "/devices/:id", component: Page1 },')
    expect(manifest).not.toContain("lazy(")
  })

  test("leaves generated entry files untouched when content is unchanged", async () => {
    const generatedDir = join(tempRoot, ".sixb", "generated")
    const routes = [
      {
        path: "/",
        filePath: join(tempRoot, "app", "page.tsx"),
        relativePath: "page.tsx",
      },
    ]

    const manifestPath = await generateRouteManifest(routes, generatedDir)
    const { htmlPath, mainPath } = await generateAppEntry(tempRoot, generatedDir)
    const files = [manifestPath, mainPath, htmlPath]
    const before = await mtimes(files)

    await wait(25)
    await generateRouteManifest(routes, generatedDir)
    await generateAppEntry(tempRoot, generatedDir)

    expect(await mtimes(files)).toEqual(before)
  })

  test("generated entry intercepts internal anchors conservatively", async () => {
    const { mainPath } = await generateAppEntry(tempRoot, join(tempRoot, ".sixb", "generated"))
    const main = await readFile(mainPath, "utf-8")

    expect(main).toContain("<InternalLinkInterceptor />")
    // The guard list is the contract: anything unusual must fall through to
    // native browser navigation.
    for (const guard of [
      "event.defaultPrevented",
      "event.button !== 0",
      "event.metaKey || event.ctrlKey || event.shiftKey || event.altKey",
      'anchor.target && anchor.target !== "_self"',
      'anchor.hasAttribute("download")',
      'anchor.relList.contains("external")',
      "url.origin !== window.location.origin",
      "isReservedPath(url.pathname)",
      "matchPath(route.path, url.pathname)",
    ]) {
      expect(main).toContain(guard)
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
    // No element-level link rules: an unlayered `a { color: inherit }` here
    // once outranked Tailwind's layered text utilities and blanked the label
    // of <Button asChild><Link/></Button> in every app.
    expect(html).not.toMatch(/(^|[\s{}])a\s*\{/)
    expect(html).not.toContain("#05070c")
    expect(html).not.toContain("#0b1222")
    expect(html).not.toContain("radial-gradient")
  })
})
