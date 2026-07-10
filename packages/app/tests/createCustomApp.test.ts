import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
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

async function linkAppTestDependencies(root: string): Promise<void> {
  const fixtureModules = join(root, "node_modules")
  await mkdir(join(fixtureModules, "@tanstack"), { recursive: true })
  await mkdir(join(fixtureModules, "@sixb"), { recursive: true })
  for (const dependency of ["react", "react-dom", "react-router-dom"]) {
    await symlink(
      join(process.cwd(), "packages", "app", "node_modules", dependency),
      join(fixtureModules, dependency),
      "dir"
    )
  }
  await symlink(
    join(process.cwd(), "packages", "app", "node_modules", "@tanstack", "react-query"),
    join(fixtureModules, "@tanstack", "react-query"),
    "dir"
  )
  await symlink(
    join(process.cwd(), "packages", "client"),
    join(fixtureModules, "@sixb", "client"),
    "dir"
  )
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
    // Keep bundling fixtures inside the workspace so Bun resolves workspace source
    // exports. Unit-test CI intentionally has no prebuilt package dist artifacts.
    tempRoot = await mkdtemp(join(import.meta.dir, "tmp-app-dev-"))
    const appDir = join(tempRoot, "app")
    await mkdir(appDir, { recursive: true })
    await writeFile(join(appDir, "page.tsx"), "export default function Page() { return null }\n")
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
    await linkAppTestDependencies(tempRoot)

    const port = await getFreePort()
    const app = await createCustomApp({ rootDir: tempRoot, authEnabled: false, agentRoutes: false })
    const server = await app.dev({ host: "127.0.0.1", port })

    try {
      const shell = await fetch(`http://127.0.0.1:${port}/`)
      expect(shell.status).toBe(200)
      expect(await shell.text()).toContain('href="/app.webmanifest"')

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

  test("renders an access-denied view without starting the application", async () => {
    const { mainPath } = await generateAppEntry(tempRoot, join(tempRoot, ".sixb", "generated"))
    const main = await readFile(mainPath, "utf-8")

    expect(main).toContain("!authSession.applicationAccess.allowed")
    expect(main).toContain("function AccessDeniedView()")
    expect(main).toContain("<AccessDeniedView />")
    expect(main).toContain("await signOut({ throwOnError: true })")
  })

  test("wraps routes in an error boundary that special-cases 404s", async () => {
    const { mainPath } = await generateAppEntry(tempRoot, join(tempRoot, ".sixb", "generated"))
    const main = await readFile(mainPath, "utf-8")

    // A safety net catches uncaught render throws instead of blanking the page.
    expect(main).toContain("class AppErrorBoundary")
    expect(main).toContain("getDerivedStateFromError")
    expect(main).toContain("<RoutedErrorBoundary>")
    // A 404 is an expected "not found" state, not the generic crash screen.
    expect(main).toContain("isSixbApiError(error) && error.status === 404")
    expect(main).toContain("import {\n  configureSixbBrowserClient,\n  isSixbApiError,")
    // Unmatched client routes render the not-found view instead of a blank page.
    expect(main).toContain('<Route path="*" element={<NotFoundView />} />')
    expect(main).toContain("function NotFoundView()")
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

    const { mainPath } = await generateAppEntry(tempRoot, generatedDir, {
      stylesheetPath: appCssPath,
      frameworkStylesheetPaths: [frameworkCssPath],
    })
    const main = await readFile(mainPath, "utf-8")

    expect(main.indexOf('import "./agent-ui.css"')).toBeGreaterThan(-1)
    expect(main.indexOf('import "../../app/globals.css"')).toBeGreaterThan(-1)
    expect(main.indexOf('import "./agent-ui.css"')).toBeLessThan(
      main.indexOf('import "../../app/globals.css"')
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
    const { htmlPath, mainPath, manifestPath } = await generateAppEntry(tempRoot, generatedDir)
    const files = [routeManifestPath, mainPath, htmlPath, manifestPath]
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

      const main = await readFile(join(tempRoot, ".sixb", "generated", "main.tsx"), "utf-8")
      expect(main).toContain('import "./agent-ui.css"')
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
