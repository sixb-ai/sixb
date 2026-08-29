import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
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
  const atlasRoot = resolve(import.meta.dir, "..", "..", "atlas")

  for (const name of packages) {
    const packageDir =
      name === "@sixb/app"
        ? resolve(import.meta.dir, "..")
        : dirname(Bun.resolveSync(`${name}/package.json`, atlasRoot))
    const target = join(projectRoot, "node_modules", ...name.split("/"))
    await mkdir(dirname(target), { recursive: true })
    await symlink(packageDir, target)
  }
}

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

  test("fails fast when an older build has no shared shell", async () => {
    const outdir = join(tempRoot, ".sixb", "dist", "app")
    await rm(join(outdir, "shared-index.html"))

    const app = await createCustomApp({ rootDir: tempRoot })
    await expect(app.start({ host: "127.0.0.1", port: await getFreePort() })).rejects.toThrow(
      /\[SixbCustomApp\] Built app in .*shared-index\.html; rebuild required/
    )
  })

  test("serves the manifest with revalidation headers for GET and HEAD", async () => {
    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot })
    const server = await app.start({ host: "127.0.0.1", port })

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

    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot, audience: "app" })
    const server = await app.start({
      host: "127.0.0.1",
      port,
      apiBaseUrl: "http://127.0.0.1:3000",
    })

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
      // segment (the IP `10.0.0.10`) lives inside a single path segment. On a hard
      // refresh this must serve the SPA shell, not 404 as a "missing asset".
      const deepRoute =
        "/point/point%3Aacme%3Aacme%2Facme_north_campus%2F10.0.0.10-100%2Fdevice%2F100"
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

  test("serves only canonical shared deep links through a nonce-secured shell", async () => {
    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot, audience: "app" })
    const server = await app.start({
      host: "127.0.0.1",
      port,
      apiBaseUrl: "https://api.example.test/base",
    })

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
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("manifest-src 'none'")

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

      const ordinary = await fetch(`http://127.0.0.1:${port}/`)
      expect(ordinary.headers.get("content-security-policy")).toBeNull()
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

  test("serves the generated manifest and conventional public icons", async () => {
    const publicDir = join(tempRoot, "app", "public")
    await mkdir(publicDir, { recursive: true })
    await writeFile(join(publicDir, "favicon.svg"), "<svg></svg>\n")
    await writeFile(join(publicDir, "icon-192.png"), "fixture png")
    await writeFile(join(publicDir, "app.webmanifest"), '{"name":"Shadow"}\n')

    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot, authEnabled: false, agentRoutes: false })
    const server = await app.dev({ host: "127.0.0.1", port })

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
      expect((await fetch(`http://127.0.0.1:${port}/missing-icon.png`)).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${port}/other.webmanifest`)).status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  test("does not build the shared browser graph for an ordinary dev server", async () => {
    const port = await getFreePort()
    const sharedDevRoot = join(tempRoot, ".sixb", "generated", "shared-dev")
    const app = await createCustomApp({ rootDir: tempRoot, authEnabled: false, agentRoutes: false })
    const server = await app.dev({ host: "127.0.0.1", port })

    try {
      // Regression proof: eagerly calling buildSharedAppDev() here makes the global parallel suite
      // hit Bun 1.3.14's shared native bundler state and report EISDIR/Unseekable reads.
      expect(await Bun.file(join(sharedDevRoot, "0")).exists()).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test("serves the app shell behind a TLS-terminating reverse proxy", async () => {
    const workspaceTempDir = resolve(import.meta.dir, "../../..", ".local", "test-tmp")
    await mkdir(workspaceTempDir, { recursive: true })
    const proxyRoot = await mkdtemp(join(workspaceTempDir, "sixb-app-proxy-"))
    await mkdir(join(proxyRoot, "app"), { recursive: true })
    await writeFile(
      join(proxyRoot, "app", "page.tsx"),
      "export default function Page() { return null }\n"
    )
    await linkDependencies(proxyRoot, [
      "@sixb/client",
      "@tanstack/react-query",
      "react",
      "react-dom",
      "react-router-dom",
    ])

    const port = await getFreePort()
    const app = await createCustomApp({
      rootDir: proxyRoot,
      authEnabled: false,
      agentRoutes: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port })

    try {
      const response = await fetch(`http://127.0.0.1:${port}/dashboard`, {
        headers: {
          host: "app.example.test",
          "x-forwarded-host": "app.example.test",
          "x-forwarded-port": "443",
          "x-forwarded-proto": "https",
        },
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('<div id="root"></div>')
    } finally {
      await server.stop()
      await rm(proxyRoot, { recursive: true, force: true })
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

  test("rejects the framework-owned app/shared directory with an actionable error", async () => {
    await mkdir(join(tempRoot, "app", "shared"), { recursive: true })
    await writeFile(
      join(tempRoot, "app", "shared", "page.tsx"),
      "export default function SharedPage() { return null }\n"
    )
    const app = await createCustomApp({ rootDir: tempRoot, agentRoutes: false })

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
        'import type { AuthExperienceProps } from "@sixb/app/auth"',
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
    expect(main).toContain("confirmSignIn()")
    expect(main).toContain("form.submit()")
    expect(html).toContain('data-sixb-auth="__SIXB_AUTH_BOOTSTRAP__"')
    expect(html).toContain('src="./auth-main.tsx"')
    expect(main).not.toContain("RootLayout")
  })

  test("renders an access-denied view without starting the application", async () => {
    const { mainPath, runtimePath } = await generateAppEntry(
      tempRoot,
      join(tempRoot, ".sixb", "generated")
    )
    const main = await readFile(mainPath, "utf-8")
    const runtime = await readFile(runtimePath, "utf-8")

    expect(main).toContain("!authSession.applicationAccess.allowed")
    expect(runtime).toContain("function AccessDeniedView()")
    expect(runtime).toContain("<AccessDeniedView />")
    expect(runtime).toContain("await signOut({ throwOnError: true })")
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
    expect(runtime).toContain('import { isSixbApiError } from "@sixb/client/browser"')
    // Unmatched client routes render the not-found view instead of a blank page.
    expect(runtime).toContain('<Route path="*" element={<NotFoundView />} />')
    expect(runtime).toContain("function NotFoundView()")
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

  test("route manifest can append framework-owned routes", async () => {
    const generatedDir = join(tempRoot, ".sixb", "generated")
    const manifestPath = await generateRouteManifest(
      [
        {
          path: "/",
          filePath: join(tempRoot, "app", "page.tsx"),
          relativePath: "page.tsx",
        },
      ],
      generatedDir,
      {
        builtInRoutes: [
          { path: "/agents", moduleSpecifier: "@sixb/app/agents" },
          { path: "/agents/new/:agentId", moduleSpecifier: "@sixb/app/agents" },
          { path: "/agents/:threadId", moduleSpecifier: "@sixb/app/agents" },
        ],
      }
    )
    const manifest = await readFile(manifestPath, "utf-8")

    expect(manifest).toContain('import Page0 from "../../app/page.tsx"')
    expect(manifest).toContain('import BuiltInPage0 from "@sixb/app/agents"')
    expect(manifest).toContain('import BuiltInPage1 from "@sixb/app/agents"')
    expect(manifest).toContain('import BuiltInPage2 from "@sixb/app/agents"')
    expect(manifest).toContain('{ path: "/", component: Page0 },')
    expect(manifest).toContain('{ path: "/agents", component: BuiltInPage0 },')
    expect(manifest).toContain('{ path: "/agents/new/:agentId", component: BuiltInPage1 },')
    expect(manifest).toContain('{ path: "/agents/:threadId", component: BuiltInPage2 },')
  })

  test("generated entry imports framework styles before app styles", async () => {
    const generatedDir = join(tempRoot, ".sixb", "generated")
    const appCssPath = join(tempRoot, "app", "globals.css")
    const frameworkCssPath = join(generatedDir, "agent-ui.css")
    await mkdir(generatedDir, { recursive: true })
    await writeFile(appCssPath, "body { margin: 0; }\n")
    await writeFile(frameworkCssPath, "body { color: black; }\n")

    const { runtimePath } = await generateAppEntry(tempRoot, generatedDir, {
      stylesheetPath: appCssPath,
      frameworkStylesheetPaths: [frameworkCssPath],
    })
    const runtime = await readFile(runtimePath, "utf-8")

    expect(runtime.indexOf('import "./agent-ui.css"')).toBeGreaterThan(-1)
    expect(runtime.indexOf('import "../../app/globals.css"')).toBeGreaterThan(-1)
    expect(runtime.indexOf('import "./agent-ui.css"')).toBeLessThan(
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
    const before = await mtimes(files)

    await wait(25)
    await generateRouteManifest(routes, generatedDir)
    await generateAppEntry(tempRoot, generatedDir)

    expect(await mtimes(files)).toEqual(before)
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
      "matchPath(route.path, appPath)",
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

  test("custom apps get default agent routes without changing scanRoutes output", async () => {
    const port = await getFreePort()
    const app = await createCustomApp({
      rootDir: tempRoot,
      apiBaseUrl: "http://127.0.0.1:3000",
      authEnabled: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port })

    try {
      expect((await app.scanRoutes()).map((route) => route.path)).toEqual(["/"])

      const manifest = await readFile(join(tempRoot, ".sixb", "generated", "routes.ts"), "utf-8")
      expect(manifest).toContain('{ path: "/", component: Page0 },')
      expect(manifest).toContain('{ path: "/agents", component: BuiltInPage0 },')
      expect(manifest).toContain('{ path: "/agents/new/:agentId", component: BuiltInPage1 },')
      expect(manifest).toContain('{ path: "/agents/:threadId", component: BuiltInPage2 },')

      const runtime = await readFile(
        join(tempRoot, ".sixb", "generated", "app-runtime.tsx"),
        "utf-8"
      )
      expect(runtime).toContain('import "./agent-ui.css"')
    } finally {
      await server.stop()
    }
  }, 30_000)

  test("project-owned agent pages override the default agent routes", async () => {
    await mkdir(join(tempRoot, "app", "agents", "new", "[agentId]"), { recursive: true })
    await mkdir(join(tempRoot, "app", "agents", "[threadId]"), { recursive: true })
    await writeFile(
      join(tempRoot, "app", "agents", "page.tsx"),
      "export default function Agents() { return null }\n"
    )
    await writeFile(
      join(tempRoot, "app", "agents", "new", "[agentId]", "page.tsx"),
      "export default function NewAgentChat() { return null }\n"
    )
    await writeFile(
      join(tempRoot, "app", "agents", "[threadId]", "page.tsx"),
      "export default function AgentThread() { return null }\n"
    )

    const port = await getFreePort()
    const app = await createCustomApp({
      rootDir: tempRoot,
      apiBaseUrl: "http://127.0.0.1:3000",
      authEnabled: false,
    })
    const server = await app.dev({ host: "127.0.0.1", port })

    try {
      const manifest = await readFile(join(tempRoot, ".sixb", "generated", "routes.ts"), "utf-8")
      expect(manifest).toContain('{ path: "/agents", component: Page')
      expect(manifest).toContain('{ path: "/agents/new/:agentId", component: Page')
      expect(manifest).toContain('{ path: "/agents/:threadId", component: Page')
      expect(manifest).not.toContain("@sixb/app/agents")
      expect(await Bun.file(join(tempRoot, ".sixb", "generated", "agent-ui.css")).exists()).toBe(
        false
      )
    } finally {
      await server.stop()
    }
  }, 30_000)
})
