import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { brotliCompressSync, gzipSync } from "node:zlib"
import {
  generateAppEntry,
  generateAuthExperienceEntry,
  generateRouteManifest,
} from "../src/codegen"
import { createCustomApp } from "../src/createCustomApp"

async function linkDependencies(projectRoot: string, packages: readonly string[]): Promise<void> {
  // Resolved as this package resolves them.
  const appRoot = resolve(import.meta.dir, "..")

  for (const name of packages) {
    const packageDir =
      name === "@sixb/app"
        ? resolve(import.meta.dir, "..")
        : dirname(Bun.resolveSync(`${name}/package.json`, appRoot))
    const target = join(projectRoot, "node_modules", ...name.split("/"))
    await mkdir(dirname(target), { recursive: true })
    await symlink(packageDir, target)
  }
}

// Every page's policy names the listed frame origins: keep the developer's own list, such as one
// Bun loads from a local .env, out of the headers these tests compare.
const ambientFrameOrigins = process.env.SIXB_APP_FRAME_ORIGINS

beforeEach(() => {
  delete process.env.SIXB_APP_FRAME_ORIGINS
})

afterEach(() => {
  if (ambientFrameOrigins === undefined) delete process.env.SIXB_APP_FRAME_ORIGINS
  else process.env.SIXB_APP_FRAME_ORIGINS = ambientFrameOrigins
})

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
    await writeFile(
      join(outdir, "shared-index.html"),
      [
        "<!DOCTYPE html>",
        "<html>",
        "  <head>",
        '    <meta name="referrer" content="no-referrer" />',
        "    <script>window.__SIXB_RUNTIME__ = {};</script>",
        "  </head>",
        '  <body><div id="root"></div><script>void import("/shared-ab12cd34.js")</script></body>',
        "</html>",
      ].join("\n")
    )
    await writeFile(join(outdir, "shared-ab12cd34.js"), "console.log('shared fixture app')\n")
    await writeFile(
      join(outdir, "app.webmanifest"),
      '{"id":"/","name":"Fixture App","start_url":"/","scope":"/","display":"standalone"}\n'
    )
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  // Regression proof: replace publicEnv: config.publicEnv with publicEnv: {} in the injector.
  // Removing the indexPath checks in the static-file branches makes the HTML aliases fail.
  test("snapshots only public env at startup and refreshes it without rebuilding", async () => {
    const previous = process.env.SIXB_PUBLIC_TEST_KEY
    const secret = process.env.SIXB_PRIVATE_TEST_KEY
    const app = await createCustomApp({ rootDir: tempRoot, authEnabled: false })
    const original = await readFile(join(tempRoot, ".sixb/dist/app/index.html"), "utf-8")
    try {
      process.env.SIXB_PRIVATE_TEST_KEY = "server-only-sentinel"
      for (const value of ['quotes" \n </script><script>alert(1)</script> $& $` ', "restarted"]) {
        process.env.SIXB_PUBLIC_TEST_KEY = value
        const server = await app.start({ host: "127.0.0.1", port: 0 })
        try {
          process.env.SIXB_PUBLIC_TEST_KEY = "changed-after-start"
          for (const path of [
            "/",
            "/index",
            "/index.html",
            "/%69ndex.html",
            "/shared/grant/page",
          ]) {
            const response = await fetch(`http://127.0.0.1:${server.port}${path}`)
            expect(response.status).toBe(200)
            expect(response.headers.get("cache-control")).toBe("no-store")
            const html = await response.text()
            const encoded = html.match(/window\.__SIXB_RUNTIME__ = (.*);<\/script>/)?.[1]
            expect(encoded).toBeDefined()
            const config = JSON.parse(encoded!)
            // A public local app tells the browser that nobody signs in.
            expect(config.auth).toEqual({ enabled: false })
            expect(config.publicEnv.SIXB_PUBLIC_TEST_KEY).toBe(value)
            expect(config.publicEnv.SIXB_PUBLIC_MISSING).toBeUndefined()
            expect(html).not.toContain("server-only-sentinel")
            expect(html).not.toContain("<script>alert(1)</script>")
            expect(html.indexOf("window.__SIXB_RUNTIME__")).toBeLessThan(html.indexOf("<body>"))
            const head = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "HEAD" })
            expect(head.status).toBe(200)
            expect(head.headers.get("cache-control")).toBe("no-store")
            expect(await head.text()).toBe("")
          }
        } finally {
          await server.stop()
        }
      }
      expect(await readFile(join(tempRoot, ".sixb/dist/app/index.html"), "utf-8")).toBe(original)
    } finally {
      if (previous === undefined) delete process.env.SIXB_PUBLIC_TEST_KEY
      else process.env.SIXB_PUBLIC_TEST_KEY = previous
      if (secret === undefined) delete process.env.SIXB_PRIVATE_TEST_KEY
      else process.env.SIXB_PRIVATE_TEST_KEY = secret
    }
  })

  // Reproduce: return the requested `port` from start(); it reports 0 and its url answers nothing.
  test("reports the port it bound when asked for port 0", async () => {
    const app = await createCustomApp({ rootDir: tempRoot })
    const server = await app.start({ host: "127.0.0.1", port: 0 })

    try {
      expect(server.port).toBeGreaterThan(0)
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
      expect(await (await fetch(server.url)).text()).toContain("Fixture App")
    } finally {
      await server.stop()
    }
  })

  test("serves the built app and injects the runtime API base URL", async () => {
    const app = await createCustomApp({ rootDir: tempRoot })
    const server = await app.start({
      host: "127.0.0.1",
      port: 0,
      apiBaseUrl: "http://127.0.0.1:3000",
    })
    const { port } = server

    try {
      const rootResponse = await fetch(`http://127.0.0.1:${port}/`)
      expect(rootResponse.status).toBe(200)
      const html = await rootResponse.text()
      expect(html).toContain("Fixture App")
      expect(html).toContain('"api":{"baseUrl":"http://127.0.0.1:3000"}')
      expect(html).toContain('"auth":{"enabled":true}')

      // Deep routes get the SPA shell on a hard refresh, including an object id whose single path
      // segment holds percent-encoded slashes and a dotted IP; neither makes it a missing asset.
      for (const route of [
        "/dashboard/devices",
        "/point/point%3Aacme%3Aacme%2Facme_north_campus%2F10.0.0.10-100%2Fdevice%2F100",
      ]) {
        const routeResponse = await fetch(`http://127.0.0.1:${port}${route}`)
        expect(routeResponse.status).toBe(200)
        expect(await routeResponse.text()).toContain('<div id="root"></div>')
      }

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

  test("lets the app's page frame only the API, where artifact frames come from", async () => {
    // A page in a frame reads rows as its reader. Its frame opens no window, so the one way left
    // to send them elsewhere is to load another site's address in the frame itself: this policy
    // refuses that navigation. Reproduce by dropping the policy from htmlResponse.
    const app = await createCustomApp({ rootDir: tempRoot })
    const split = await app.start({ host: "127.0.0.1", port: 0, apiBaseUrl: "https://api.test/v1" })
    const same = await app.start({ host: "127.0.0.1", port: 0 })

    try {
      for (const route of ["/", "/dashboard/devices", "/index.html"]) {
        const response = await fetch(`http://127.0.0.1:${split.port}${route}`)
        expect(response.headers.get("content-security-policy"), route).toBe(
          "frame-src https://api.test"
        )
      }

      // Served beside the app, the API is the page's own origin.
      const response = await fetch(`http://127.0.0.1:${same.port}/`, { method: "HEAD" })
      expect(response.headers.get("content-security-policy")).toBe("frame-src 'self'")
    } finally {
      await split.stop()
      await same.stop()
    }
  })

  // Reproduce: pass [] for frameOrigins to htmlResponse or sharedHtmlResponse in start().
  test("frames the sites SIXB_APP_FRAME_ORIGINS lists, on app and shared pages", async () => {
    const app = await createCustomApp({ rootDir: tempRoot })
    process.env.SIXB_APP_FRAME_ORIGINS =
      "https://Contoso.sharepoint.com/, https://api.test, https://www.youtube-nocookie.com"
    const server = await app.start({
      host: "127.0.0.1",
      port: 0,
      apiBaseUrl: "https://api.test/v1",
    })
    // Read when the server starts, like public env: a change takes a restart.
    process.env.SIXB_APP_FRAME_ORIGINS = "https://changed-after-start.test"

    try {
      // The API's origin, listed again, is not repeated.
      const listed =
        "https://api.test https://contoso.sharepoint.com https://www.youtube-nocookie.com"
      for (const route of ["/", "/dashboard/devices"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}${route}`)
        expect(response.headers.get("content-security-policy"), route).toBe(`frame-src ${listed}`)
      }

      const shared = await fetch(`http://127.0.0.1:${server.port}/shared/shr_1/reports/report-1`)
      const csp = shared.headers.get("content-security-policy") ?? ""
      expect(csp).toContain(`frame-src ${listed};`)
      expect(csp).toContain("default-src 'none'")
    } finally {
      await server.stop()
    }
  })

  // Reproduce: drop readAppFrameOrigins from start(), and the server starts with no list at all.
  test("refuses to start with a frame origin that is not exact", async () => {
    const app = await createCustomApp({ rootDir: tempRoot })
    process.env.SIXB_APP_FRAME_ORIGINS = "https://*.sharepoint.com"

    const error = await app.start({ host: "127.0.0.1", port: 0 }).catch((error) => error)

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(
      "[SixbCustomApp] SIXB_APP_FRAME_ORIGINS: 'https://*.sharepoint.com' is a wildcard."
    )
  })

  // Regression proof: drop the `/__sixb/assets/` branch from start() and the icon request is
  // answered as a missing asset.
  test("serves the built-in pages' connector icons from the package", async () => {
    const app = await createCustomApp({ rootDir: tempRoot })
    const server = await app.start({ host: "127.0.0.1", port: 0 })
    const { port } = server

    try {
      const icon = await fetch(`http://127.0.0.1:${port}/__sixb/assets/connector-icons/github.svg`)
      expect(icon.status).toBe(200)
      expect(icon.headers.get("content-type")).toContain("image/svg+xml")
      expect(icon.headers.get("cache-control")).toBe("public, max-age=86400")
      for (const path of [
        "/__sixb/assets/connector-icons/missing.svg",
        "/__sixb/assets/connector-icons/..%2F..%2Fpackage.json",
      ]) {
        expect((await fetch(`http://127.0.0.1:${port}${path}`)).status).toBe(404)
      }
    } finally {
      await server.stop()
    }
  })

  test("fails fast when an older build has no shared shell", async () => {
    const outdir = join(tempRoot, ".sixb", "dist", "app")
    await rm(join(outdir, "shared-index.html"))

    const app = await createCustomApp({ rootDir: tempRoot })
    const error = await app.start({ host: "127.0.0.1", port: 0 }).catch((caught) => caught)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(
      /\[SixbCustomApp\] Built app in .*shared-index\.html; rebuild required/
    )
  })

  test("serves the manifest with revalidation headers for GET and HEAD", async () => {
    const app = await createCustomApp({ rootDir: tempRoot })
    const server = await app.start({ host: "127.0.0.1", port: 0 })
    const { port } = server

    try {
      const manifest = await fetch(`http://127.0.0.1:${port}/app.webmanifest`)
      expect(manifest.status).toBe(200)
      expect(manifest.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8")
      expect(manifest.headers.get("cache-control")).toBe("no-cache")
      expect((await manifest.json()).name).toBe("Fixture App")

      const head = await fetch(`http://127.0.0.1:${port}/app.webmanifest`, { method: "HEAD" })
      expect(head.status).toBe(200)
      expect(head.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8")
      expect(head.headers.get("cache-control")).toBe("no-cache")
      expect(await head.text()).toBe("")
    } finally {
      await server.stop()
    }
  })

  test("serves hashed build chunks with immutable cache headers", async () => {
    const outdir = join(tempRoot, ".sixb", "dist", "app")
    const javascript = "console.log('chunk')\n"
    const stylesheet = "body{}\n"
    await writeFile(join(outdir, "chunk-ab12cd34.js"), javascript)
    await writeFile(join(outdir, "chunk-ab12cd34.js.br"), brotliCompressSync(javascript))
    await writeFile(join(outdir, "chunk-ab12cd34.css"), stylesheet)
    await writeFile(join(outdir, "chunk-ab12cd34.css.gz"), gzipSync(stylesheet))

    const app = await createCustomApp({ rootDir: tempRoot })
    const server = await app.start({
      host: "127.0.0.1",
      port: 0,
      apiBaseUrl: "http://127.0.0.1:3000",
    })
    const { port } = server

    try {
      const immutable = "public, max-age=31536000, immutable"
      const chunkJs = await fetch(`http://127.0.0.1:${port}/chunk-ab12cd34.js`, {
        headers: { "accept-encoding": "br, gzip" },
      })
      expect(chunkJs.status).toBe(200)
      expect(chunkJs.headers.get("cache-control")).toBe(immutable)
      expect(chunkJs.headers.get("content-encoding")).toBe("br")
      expect(chunkJs.headers.get("vary")).toContain("Accept-Encoding")
      expect(await chunkJs.text()).toBe(javascript)

      const chunkCss = await fetch(`http://127.0.0.1:${port}/chunk-ab12cd34.css`, {
        headers: { "accept-encoding": "gzip" },
      })
      expect(chunkCss.headers.get("cache-control")).toBe(immutable)
      expect(chunkCss.headers.get("content-encoding")).toBe("gzip")
      expect(chunkCss.headers.get("vary")).toContain("Accept-Encoding")
      expect(await chunkCss.text()).toBe(stylesheet)

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

  test("serves only canonical shared deep links through a nonce-secured shell", async () => {
    const app = await createCustomApp({ rootDir: tempRoot })
    const server = await app.start({
      host: "127.0.0.1",
      port: 0,
      apiBaseUrl: "https://api.example.test/base",
    })
    const { port } = server

    try {
      const shared = await fetch(`http://127.0.0.1:${port}/shared/shr_1/reports/report-1`)
      expect(shared.status).toBe(200)
      expect(shared.headers.get("cache-control")).toBe("no-store")
      expect(shared.headers.get("referrer-policy")).toBe("no-referrer")
      expect(shared.headers.get("permissions-policy")).toContain("camera=()")
      expect(shared.headers.get("x-content-type-options")).toBe("nosniff")
      expect(shared.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive")
      expect(shared.headers.get("link")).toBeNull()

      const html = await shared.text()
      const nonces = [...html.matchAll(/<script nonce="([^"]+)"/g)].map((match) => match[1])
      expect(nonces).toHaveLength(2)
      expect(new Set(nonces).size).toBe(1)
      const csp = shared.headers.get("content-security-policy") ?? ""
      expect(csp).toContain(`script-src 'nonce-${nonces[0]}'`)
      expect(csp).toContain("connect-src 'self' https://api.example.test")
      // Without media-src, <video> and <audio> fall back to default-src 'none' and stay blank,
      // even for a blob: URL built from a successful fetch.
      for (const directive of ["img-src", "media-src"]) {
        expect(csp).toContain(`${directive} 'self' https://api.example.test data: blob: https:`)
      }
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("manifest-src 'none'")
      // It frames the artifact frames the API serves, and nothing else.
      expect(csp).toContain("frame-src https://api.example.test;")

      const head = await fetch(`http://127.0.0.1:${port}/shared/shr_1/`, { method: "HEAD" })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe("")
      expect(head.headers.get("cache-control")).toBe("no-store")
      expect(head.headers.get("content-security-policy")).not.toBe(csp)

      const root = await fetch(`http://127.0.0.1:${port}/shared/shr_1`)
      expect(root.status).toBe(200)
      expect(root.headers.get("cache-control")).toBe("no-store")

      for (const pathname of [
        "/shared",
        "/shared/",
        "/shared/shr_1/missing.js",
        "/shared%2Fshr_1%2Freports%2Freport-1",
        "/shared-index.html",
        "/%73hared-index.html",
        "/__sixb/generated/app-shell",
        "/__sixb/generated/shared-app-shell",
      ]) {
        const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
        expect(response.status).toBe(404)
        expect(response.headers.get("cache-control")).toBe("no-store")
      }

      const mutation = await fetch(`http://127.0.0.1:${port}/shared/shr_1/reports/report-1`, {
        method: "POST",
      })
      expect(mutation.status).toBe(404)
      expect(mutation.headers.get("cache-control")).toBe("no-store")
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/shared/shr_1`, {
            method: "DELETE",
          })
        ).status
      ).toBe(404)

      // The app's own page restricts only where its frames go: see the next test.
      const ordinary = await fetch(`http://127.0.0.1:${port}/`)
      expect(ordinary.headers.get("content-security-policy")).toBe(
        "frame-src https://api.example.test"
      )
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
    await linkDependencies(tempRoot, [
      "@sixb/app",
      "@sixb/client",
      "@tanstack/react-query",
      "react",
      "react-dom",
      "react-router-dom",
    ])
  })

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  // Regression proof: replace publicEnv: config.publicEnv with publicEnv: {} in the injector.
  // Remove the fixture tsconfig with app/client dist absent to reproduce the clean-CI failure.
  // Forwarding the proxy's host headers to the internal shell request breaks the proxied fetch.
  test("delivers public env before the development app entry, also behind a TLS-terminating proxy", async () => {
    const previous = process.env.SIXB_PUBLIC_TEST_KEY
    process.env.SIXB_PUBLIC_TEST_KEY = "dev-runtime-sentinel"
    process.env.SIXB_APP_FRAME_ORIGINS = "https://frames.example.test"
    const app = await createCustomApp({
      rootDir: tempRoot,
      authEnabled: false,
      builtInPages: false,
    })
    let server: Awaited<ReturnType<typeof app.dev>> | undefined
    try {
      // Unit CI runs from source without building package exports first.
      await writeFile(
        join(tempRoot, "tsconfig.json"),
        JSON.stringify({ extends: resolve(import.meta.dir, "../../../tsconfig.json") })
      )
      await writeFile(
        join(tempRoot, "app/page.tsx"),
        'import { publicEnv } from "@sixb/app"\nconst key = publicEnv.SIXB_PUBLIC_TEST_KEY\nexport default function Page() { return <main>{key}</main> }\n'
      )
      server = await app.dev({ host: "127.0.0.1", port: 0 })
      process.env.SIXB_PUBLIC_TEST_KEY = "changed-after-start"
      const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text()
      const encoded = html.match(/window\.__SIXB_RUNTIME__ = (.*);<\/script>/)?.[1]
      expect(encoded).toBeDefined()
      expect(JSON.parse(encoded!).publicEnv.SIXB_PUBLIC_TEST_KEY).toBe("dev-runtime-sentinel")
      expect(html.indexOf("window.__SIXB_RUNTIME__")).toBeLessThan(
        html.indexOf('<script type="module"')
      )
      const generated = await readFile(join(tempRoot, ".sixb/generated/index.html"), "utf-8")
      expect(generated).not.toContain("dev-runtime-sentinel")

      const proxied = await fetch(`http://127.0.0.1:${server.port}/dashboard`, {
        headers: {
          host: "app.example.test",
          "x-forwarded-host": "app.example.test",
          "x-forwarded-port": "443",
          "x-forwarded-proto": "https",
        },
      })
      expect(proxied.status).toBe(200)
      expect(await proxied.text()).toContain('<div id="root"></div>')
      // In development too, the page frames only the API's artifact frames, here its own origin,
      // and the listed sites. Reproduce by dropping the policy from spaHtmlRoute.
      expect(proxied.headers.get("content-security-policy")).toBe(
        "frame-src 'self' https://frames.example.test"
      )
    } finally {
      await server?.stop()
      if (previous === undefined) delete process.env.SIXB_PUBLIC_TEST_KEY
      else process.env.SIXB_PUBLIC_TEST_KEY = previous
    }
  })

  // Reproduce: return the requested `port` from dev(); it reports 0 and its url answers nothing.
  test("reports the port it bound when asked for port 0", async () => {
    const app = await createCustomApp({
      rootDir: tempRoot,
      authEnabled: false,
      builtInPages: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port: 0 })

    try {
      expect(server.port).toBeGreaterThan(0)
      expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
      expect((await fetch(`${server.url}/app.webmanifest`)).status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("serves the generated manifest and public icons, and keeps API-owned routes off the dev origin", async () => {
    const publicDir = join(tempRoot, "app", "public")
    await mkdir(publicDir, { recursive: true })
    await writeFile(join(publicDir, "favicon.svg"), "<svg></svg>\n")
    await writeFile(join(publicDir, "icon-192.png"), "fixture png")
    await writeFile(join(publicDir, "app.webmanifest"), '{"name":"Shadow"}\n')

    const app = await createCustomApp({
      rootDir: tempRoot,
      authEnabled: false,
      builtInPages: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port: 0 })
    const { port } = server

    try {
      const generatedHtml = await readFile(
        join(tempRoot, ".sixb", "generated", "index.html"),
        "utf-8"
      )
      expect(generatedHtml).toContain('href="/app.webmanifest"')

      for (const method of ["GET", "HEAD"]) {
        const manifest = await fetch(`http://127.0.0.1:${port}/app.webmanifest`, { method })
        expect(manifest.status).toBe(200)
        expect(manifest.headers.get("content-type")).toBe(
          "application/manifest+json; charset=utf-8"
        )
        expect(manifest.headers.get("cache-control")).toBe("no-cache")
        if (method === "GET") {
          expect((await manifest.json()).name).toBe("Sixb")
        }
      }

      const icon = await fetch(`http://127.0.0.1:${port}/icon-192.png`)
      expect(icon.status).toBe(200)
      expect(icon.headers.get("content-type")).toBe("image/png")
      // The built-in pages' own files come from the package, not the project.
      const connectorIcon = await fetch(
        `http://127.0.0.1:${port}/__sixb/assets/connector-icons/stripe.svg`
      )
      expect(connectorIcon.status).toBe(200)
      expect(connectorIcon.headers.get("content-type")).toContain("image/svg+xml")
      expect((await fetch(`http://127.0.0.1:${port}/missing-icon.png`)).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${port}/other.webmanifest`)).status).toBe(404)

      // The Sixb API owns these paths; the dev app origin must not answer them.
      expect((await fetch(`http://127.0.0.1:${port}/api/project`)).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${port}/auth/sign-in`)).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${port}/devices`, { method: "POST" })).status).toBe(404)

      // Regression proof: eagerly calling buildSharedAppDev() at startup makes the global parallel
      // suite hit Bun 1.3.14's shared native bundler state and report EISDIR/Unseekable reads.
      const sharedDevRoot = join(tempRoot, ".sixb", "generated", "shared-dev")
      expect(existsSync(join(sharedDevRoot, "0"))).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test("rejects the framework-owned app/shared directory with an actionable error", async () => {
    await mkdir(join(tempRoot, "app", "shared"), { recursive: true })
    await writeFile(
      join(tempRoot, "app", "shared", "page.tsx"),
      "export default function SharedPage() { return null }\n"
    )
    const app = await createCustomApp({ rootDir: tempRoot, builtInPages: false })

    await expect(app.scanRoutes()).rejects.toThrow(
      "[SixbCustomApp] app/shared is reserved for framework-managed shared links"
    )
  })

  test("generates an eager entry with no lazy routes or Suspense gap", async () => {
    const { mainPath, runtimePath } = await generateAppEntry(
      tempRoot,
      join(tempRoot, ".sixb", "generated")
    )
    const main = await readFile(mainPath, "utf-8")
    const runtime = await readFile(runtimePath, "utf-8")

    // Routes render synchronously after auth — no Suspense fallback frame.
    expect(runtime).not.toContain("lazy(")
    expect(runtime).not.toContain("Suspense")
    expect(main).toContain("requireSixbBrowserAuthSession(runtimeConfig")
    expect(main).toContain("import.meta.hot.dispose")
    expect(main).toContain("browserClient.dispose()")
    expect(runtime).toContain("import.meta.hot.data as CustomAppHotData")
    expect(runtime).toContain("data.root ??= createRoot(element)")
    expect(runtime).toContain("data.queryClient ??= createQueryClient()")
    expect(runtime).toContain("getRoot().render(<App basename={options.basename} />)")
    expect(runtime).not.toContain('createRoot(document.getElementById("root")!).render')
  })

  test("generates a separate pre-auth entry when app/auth.tsx exists", async () => {
    await writeFile(
      join(tempRoot, "app", "auth.tsx"),
      [
        'import type { AuthExperienceProps } from "@sixb/app"',
        "export default function AuthExperience(_props: AuthExperienceProps) { return null }",
        "",
      ].join("\n")
    )
    const generatedDir = join(tempRoot, ".sixb", "generated")
    const entry = await generateAuthExperienceEntry(tempRoot, generatedDir)
    if (!entry) throw new Error("Expected an auth experience entry")

    const main = await readFile(entry.mainPath, "utf-8")
    const html = await readFile(entry.htmlPath, "utf-8")
    expect(main).toContain('import AuthExperience from "../../app/auth.tsx"')
    expect(main).toContain("requestMagicLink(email)")
    expect(main).toContain("confirmSignIn(input)")
    // `onClick={actions.confirmSignIn}` hands over the click event, which must not become a name.
    expect(main).toContain('typeof input?.displayName === "string"')
    expect(main).toContain("form.submit()")
    expect(html).toContain('data-sixb-auth="__SIXB_AUTH_BOOTSTRAP__"')
    expect(html).toContain('src="./auth-main.tsx"')
    expect(main).not.toContain("RootLayout")
  })

  test("renders an API-unavailable view instead of a blank page when the session fails", async () => {
    const { mainPath, runtimePath } = await generateAppEntry(
      tempRoot,
      join(tempRoot, ".sixb", "generated")
    )
    const main = await readFile(mainPath, "utf-8")
    const runtime = await readFile(runtimePath, "utf-8")

    // The session request is the first call to the API: unreachable, CORS, or a 5xx all land here.
    expect(main).toContain("requireSixbBrowserAuthSession(runtimeConfig, browserClient).catch(")
    expect(main).toContain("renderApiUnavailable(runtimeConfig.api.baseUrl)")
    expect(runtime).toContain("export function renderApiUnavailable(apiBaseUrl: string)")
    expect(runtime).toContain("messages.apiUnavailable.title")
  })

  test("wraps routes in an error boundary that special-cases 404s", async () => {
    const { runtimePath } = await generateAppEntry(tempRoot, join(tempRoot, ".sixb", "generated"))
    const runtime = await readFile(runtimePath, "utf-8")

    // A safety net catches uncaught render throws instead of blanking the page.
    expect(runtime).toContain("class AppErrorBoundary")
    expect(runtime).toContain("getDerivedStateFromError")
    expect(runtime).toContain("function RoutedErrorBoundary")
    // A 404 is an expected "not found" state, not the generic crash screen.
    expect(runtime).toContain("isSixbApiError(error) && error.status === 404")
    expect(runtime).toContain(
      'import { isSixbApiError, recordSixbPageView } from "@sixb/client/browser"'
    )
    // Unmatched client routes render the not-found view instead of a blank page.
    expect(runtime).toContain('{ path: "*", element: <NotFoundView /> }')
    expect(runtime).toContain("return useRoutes(appRoutes)")
    expect(runtime).toContain("function NotFoundView()")
  })

  // Reproduce: drop the provider from `layoutWrapperStart` in generateAppEntry; chats show only
  // the framework's views. Built-in pages off is the case that used to import the layout's default
  // export alone.
  test("hands the layout's toolViews to every chat, shared links included", async () => {
    const generatedDir = join(tempRoot, ".sixb", "generated")
    const { runtimePath } = await generateAppEntry(tempRoot, generatedDir)
    // No layout, no export to read: chats keep the framework's views.
    expect(await readFile(runtimePath, "utf-8")).not.toContain("AgentToolViewsProvider")

    await writeFile(
      join(tempRoot, "app", "layout.tsx"),
      "export default function RootLayout({ children }) { return children }\n"
    )
    for (const sections of [false, true]) {
      await generateAppEntry(tempRoot, generatedDir, { sections })
      const runtime = await readFile(runtimePath, "utf-8")

      // Read without naming it, so a layout without the export still bundles without a warning.
      expect(runtime).toContain(
        'import RootLayout, * as rootLayoutModule from "../../app/layout.tsx"'
      )
      expect(runtime).toContain('import { AgentToolViewsProvider } from "@sixb/app/pages"')
      expect(runtime).toContain('const toolViews = Reflect.get(rootLayoutModule, "toolViews")')
      // Inside the error boundary, around the layout: its own chats, every page's, and a shared
      // link's, which renders the same RoutedApp under a basename.
      expect(runtime).toContain(
        "<RoutedErrorBoundary hideErrorDetails={hideErrorDetails}>\n      <AgentToolViewsProvider views={toolViews}><RootLayout>"
      )
      expect(runtime).toContain(
        "</RootLayout></AgentToolViewsProvider>\n    </RoutedErrorBoundary>"
      )
    }
  })

  // Reproduce: drop the `recordsActivity` filter in generateRouteManifest; tooling is recorded.
  test("route manifest lists the pages whose views are activity", async () => {
    const generatedDir = join(tempRoot, ".sixb", "generated")
    const manifestPath = await generateRouteManifest(
      [{ path: "/", filePath: join(tempRoot, "app", "page.tsx"), relativePath: "page.tsx" }],
      generatedDir,
      {
        builtInRoutes: [
          {
            path: "/threads",
            moduleSpecifier: "@sixb/app/pages",
            exportName: "ThreadsPage",
          },
          {
            path: "/console/logs",
            moduleSpecifier: "@sixb/app/pages",
            exportName: "ConsoleLogsPage",
            recordsActivity: false,
          },
        ],
      }
    )
    const manifest = await readFile(manifestPath, "utf-8")

    expect(manifest).toContain('"/console/logs"')
    expect(recordedRoutePaths(manifest)).toEqual(["/", "/threads"])
  })

  // Composed layouts render through the generated routes in nested-layouts.test.tsx.
  test("route manifest statically imports every page, and no layout without pages", async () => {
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
      generatedDir,
      {
        layouts: [
          {
            path: "/orphan",
            filePath: join(tempRoot, "app", "orphan", "layout.tsx"),
            relativePath: "orphan/layout.tsx",
          },
        ],
      }
    )
    const manifest = await readFile(manifestPath, "utf-8")

    expect(manifest).toContain('import Page0 from "../../app/page.tsx"')
    expect(manifest).toContain('import Page1 from "../../app/devices/[id]/page.tsx"')
    expect(manifest).toContain('export const routePaths = [\n  "/",\n  "/devices/:id"\n]')
    expect(manifest).toContain('{ path: "/", element: createElement(Page0) },')
    expect(manifest).toContain('path: "devices"')
    expect(manifest).toContain('{ path: ":id", element: createElement(Page1) },')
    expect(manifest).not.toContain("lazy(")
    expect(manifest).not.toContain("orphan/layout.tsx")
  })

  test("generated entry imports framework styles before app styles", async () => {
    const generatedDir = join(tempRoot, ".sixb", "generated")
    const appCssPath = join(tempRoot, "app", "globals.css")
    const frameworkCssPath = join(generatedDir, "framework.css")
    await mkdir(generatedDir, { recursive: true })
    await writeFile(appCssPath, "body { margin: 0; }\n")
    await writeFile(frameworkCssPath, "body { color: black; }\n")

    const { runtimePath } = await generateAppEntry(tempRoot, generatedDir, {
      stylesheetPath: appCssPath,
      frameworkStylesheetPaths: [frameworkCssPath],
    })
    const runtime = await readFile(runtimePath, "utf-8")

    expect(runtime.indexOf('import "./framework.css"')).toBeGreaterThan(-1)
    expect(runtime.indexOf('import "../../app/globals.css"')).toBeGreaterThan(-1)
    expect(runtime.indexOf('import "./framework.css"')).toBeLessThan(
      runtime.indexOf('import "../../app/globals.css"')
    )
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

    const routeManifestPath = await generateRouteManifest(routes, generatedDir)
    const { htmlPath, mainPath, manifestPath, runtimePath, sharedHtmlPath, sharedMainPath } =
      await generateAppEntry(tempRoot, generatedDir)
    const files = [
      routeManifestPath,
      mainPath,
      runtimePath,
      sharedMainPath,
      htmlPath,
      sharedHtmlPath,
      manifestPath,
    ]
    // Backdate every file instead of waiting out the clock: a rewrite moves its mtime to now.
    const past = new Date("2026-01-01T00:00:00.000Z")
    await Promise.all(files.map((path) => utimes(path, past, past)))

    await generateRouteManifest(routes, generatedDir)
    await generateAppEntry(tempRoot, generatedDir)

    expect(await mtimes(files)).toEqual(files.map(() => past.getTime()))
  })

  test("generated entry intercepts internal anchors conservatively", async () => {
    const { runtimePath } = await generateAppEntry(tempRoot, join(tempRoot, ".sixb", "generated"))
    const runtime = await readFile(runtimePath, "utf-8")

    expect(runtime).toContain("<InternalLinkInterceptor basename={basename} />")
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
      "isReservedPath(appPath)",
      "matchPath(path, appPath)",
    ]) {
      expect(runtime).toContain(guard)
    }
  })

  test("generates a structural shell without framework visual styles", async () => {
    const { htmlPath } = await generateAppEntry(tempRoot, join(tempRoot, ".sixb", "generated"))
    const html = await readFile(htmlPath, "utf-8")

    expect(html).toContain("box-sizing: border-box")
    expect(html).toContain("margin: 0")
    expect(html).toContain("min-height: 100vh")
    expect(html).toContain("min-height: 100dvh")
    expect(html).toContain('<meta name="theme-color" content="#ffffff" />')
    expect(html).toContain("@media (display-mode: standalone)")
    expect(html).toContain("overscroll-behavior: none")
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

  // A project with its own home, a threads layout, its own members page and a root layout
  // that narrows Settings: the built-in pages fill in around what the project owns.
  test("adds the built-in pages around the project's own routes, without changing scanRoutes output", async () => {
    await mkdir(join(tempRoot, "app", "threads"), { recursive: true })
    await writeFile(
      join(tempRoot, "app", "threads", "layout.tsx"),
      "export default function ThreadsLayout({ children }) { return children }\n"
    )
    await mkdir(join(tempRoot, "app", "settings", "members"), { recursive: true })
    await writeFile(
      join(tempRoot, "app", "settings", "members", "page.tsx"),
      "export default function Members() { return null }\n"
    )
    await writeFile(
      join(tempRoot, "app", "layout.tsx"),
      "export default function RootLayout({ children }) { return children }\n"
    )
    const app = await createCustomApp({
      rootDir: tempRoot,
      apiBaseUrl: "http://127.0.0.1:3000",
      authEnabled: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port: 0 })

    try {
      expect((await app.scanRoutes()).map((route) => route.path)).toEqual([
        "/",
        "/settings/members",
      ])

      const manifest = await readFile(join(tempRoot, ".sixb", "generated", "routes.ts"), "utf-8")
      // The default thread pages nest under the project's threads layout.
      expect(manifest).toContain('import Layout0 from "../../app/threads/layout.tsx"')
      expect(manifest).toContain(
        "element: createElement(Layout0, { children: createElement(Outlet) })"
      )
      expect(manifest).toContain("{ index: true, element: createElement(BuiltInPage0) },")
      expect(manifest).toContain('{ path: ":threadId", element: createElement(BuiltInPage1) },')
      // The project's app/page.tsx owns the root, so the built-in home stays out.
      expect(manifest).not.toContain("HomePage")
      for (const page of ["SettingsIndexPage", "SettingsPersonalPage", "SettingsMemoryPage"]) {
        expect(manifest).toContain(`import { ${page} as BuiltInPage`)
      }
      // The Console's pages come with one page per item below each list.
      for (const page of [
        "ConsoleIndexPage",
        "ConsoleConnectorsPage",
        "ConsoleSyncsPage",
        "ConsoleSyncPage",
      ]) {
        expect(manifest).toContain(`import { ${page} as BuiltInPage`)
      }
      expect(manifest).toContain('":syncId"')
      // The project's members page replaces the built-in one.
      expect(manifest).not.toContain("SettingsMembersPage")
      expect(manifest).toContain('import Page1 from "../../app/settings/members/page.tsx"')

      // The built-in sections are developer tooling, so their views are not app activity; the
      // project's own page at a section path is. Reproduce: drop `recordsActivity: false` from
      // builtInRoutesFor and the Settings pages are recorded.
      const recorded = recordedRoutePaths(manifest)
      expect(recorded).toContain("/settings/members")
      expect(recorded).toContain("/threads/:threadId")
      // The old thread address only redirects.
      expect(recorded).not.toContain("/agents/:threadId")
      expect(manifest).toContain('"/agents/:threadId"')
      expect(recorded).toContain("/objects/:objectTypeId/:primaryId")
      for (const path of ["/settings", "/settings/personal", "/settings/activity"]) {
        expect(recorded).not.toContain(path)
        expect(manifest).toContain(`"${path}"`)
      }

      const runtime = await readFile(
        join(tempRoot, ".sixb", "generated", "app-runtime.tsx"),
        "utf-8"
      )
      expect(runtime).toContain('import "./framework.css"')
      // The layout wraps the sections, which shared links leave out.
      expect(runtime).toContain(
        'import RootLayout, * as rootLayoutModule from "../../app/layout.tsx"'
      )
      expect(runtime).toContain("<SectionsProvider enabled={!basename}>")
    } finally {
      await server.stop()
    }
  }, 30_000)

  // Regression proof: make servesApp in createCustomApp return routes.length > 0 and the server
  // refuses to start; drop `defaultShell` in codegen and the pages render without a shell.
  test("serves the built-in pages in the default shell without an app folder", async () => {
    await rm(join(tempRoot, "app"), { recursive: true, force: true })
    const pagesOff = await createCustomApp({
      rootDir: tempRoot,
      builtInPages: false,
      authEnabled: false,
    })
    await expect(pagesOff.dev({ host: "127.0.0.1", port: 0 })).rejects.toThrow(
      "No app routes found"
    )

    const app = await createCustomApp({
      rootDir: tempRoot,
      apiBaseUrl: "http://127.0.0.1:3000",
      authEnabled: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port: 0 })
    try {
      // Nothing to watch until the project creates `app/`; `sixb dev` restarts then.
      expect(server.watchesSources).toBe(false)
      const manifest = await readFile(join(tempRoot, ".sixb", "generated", "routes.ts"), "utf-8")
      expect(manifest).toContain('import { HomePage as BuiltInPage3 } from "@sixb/app/pages"')
      expect(manifest).toContain("{ ThreadsPage as BuiltInPage0 }")
      const runtime = await readFile(
        join(tempRoot, ".sixb", "generated", "app-runtime.tsx"),
        "utf-8"
      )
      expect(runtime).toContain('import { AppShell } from "@sixb/app"')
      expect(runtime).toContain("<AppShell>")
      expect(runtime).not.toContain("RootLayout")
    } finally {
      await server.stop()
    }
  }, 30_000)

  // Atlas shipped prebuilt; the app is bundled from the project, so React has to be installed
  // there. Regression proof: drop assertAppPackagesInstalled and this fails on Bun's bare
  // "Bundle failed" instead.
  test("names the packages to install when the project lacks React", async () => {
    const bare = await mkdtemp(join(tmpdir(), "sixb-app-bare-"))
    try {
      await linkDependencies(bare, ["@sixb/app", "react"])
      const app = await createCustomApp({ rootDir: bare, authEnabled: false })
      await expect(app.build({ outdir: join(bare, "dist") })).rejects.toThrow(
        "The app needs react-dom, react-router-dom, @tanstack/react-query in this project. " +
          "Install them with: bun add react-dom react-router-dom @tanstack/react-query"
      )
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  test("serves the built-in home until the project adds app/page.tsx, and project thread pages replace the defaults", async () => {
    await rm(join(tempRoot, "app", "page.tsx"))
    await mkdir(join(tempRoot, "app", "quotes"), { recursive: true })
    await writeFile(
      join(tempRoot, "app", "quotes", "page.tsx"),
      "export default function Quotes() { return null }\n"
    )
    await mkdir(join(tempRoot, "app", "threads", "[thread]"), { recursive: true })
    await writeFile(
      join(tempRoot, "app", "threads", "page.tsx"),
      "export default function Threads() { return null }\n"
    )
    await writeFile(
      join(tempRoot, "app", "threads", "[thread]", "page.tsx"),
      "export default function Thread() { return null }\n"
    )

    const app = await createCustomApp({
      rootDir: tempRoot,
      apiBaseUrl: "http://127.0.0.1:3000",
      authEnabled: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port: 0 })

    try {
      const manifest = await readFile(join(tempRoot, ".sixb", "generated", "routes.ts"), "utf-8")
      const home = manifest.match(
        /import \{ HomePage as (BuiltInPage\d+) \} from "@sixb\/app\/pages"/
      )
      expect(home).not.toBeNull()
      expect(manifest).toContain(`element: createElement(${home?.[1]})`)
      expect(manifest).toContain('"/quotes"')
      // Project pages at the thread paths win, whatever their parameters are called.
      expect(manifest).toContain('"/threads"')
      expect(manifest).toContain('"/threads/:thread"')
      expect(manifest).not.toContain("{ ThreadsPage as")
      expect(manifest).not.toContain("{ ThreadPage as")
    } finally {
      await server.stop()
    }
  }, 30_000)
})

/** The `activityRoutePaths` a generated route manifest declares. */
function recordedRoutePaths(manifest: string): string[] {
  const match = manifest.match(
    /export const activityRoutePaths: readonly string\[\] = (\[[^\]]*\])/
  )
  if (!match?.[1]) throw new Error("The manifest declares no activityRoutePaths.")
  return JSON.parse(match[1])
}
