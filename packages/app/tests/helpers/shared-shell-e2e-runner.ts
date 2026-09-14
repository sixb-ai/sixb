import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { createCustomApp } from "../../src/createCustomApp"

const scenario = process.argv[2]
const projectRoot = process.argv[3]
if (!scenario || !projectRoot) {
  throw new Error("Expected a shared-shell scenario and isolated project root.")
}

await prepareProject(projectRoot)
if (scenario === "dev") {
  await runDev(projectRoot)
} else if (scenario === "production") {
  await runProduction(projectRoot)
} else {
  throw new Error(`Unknown shared-shell scenario ${JSON.stringify(scenario)}.`)
}

async function runDev(root: string): Promise<void> {
  const port = await getFreePort()
  const app = await createCustomApp({
    rootDir: root,
    apiBaseUrl: "https://api.example.test/v1",
    authEnabled: false,
    agentRoutes: false,
  })
  const server = await app.dev({ host: "127.0.0.1", port })

  try {
    const origin = `http://127.0.0.1:${port}`
    const normal = await fetch(`${origin}/`)
    const sharedDevRoot = join(root, ".sixb", "generated", "shared-dev")
    assert(
      !(await Bun.file(join(sharedDevRoot, "0")).exists()),
      "ordinary dev startup must not build the shared graph"
    )
    const [shared, concurrentShared] = await Promise.all([
      fetch(`${origin}/shared/shr_1/reports/report-1`),
      fetch(`${origin}/shared/shr_1`),
    ])
    assertEqual(normal.status, 200, "dev normal shell status")
    assertEqual(shared.status, 200, "dev shared shell status")
    assertEqual(concurrentShared.status, 200, "concurrent dev shared shell status")
    assertEqual(
      JSON.stringify((await readdir(sharedDevRoot)).sort()),
      JSON.stringify(["0"]),
      "concurrent first requests share one dev build"
    )
    assert((await normal.text()) !== (await shared.clone().text()), "dev shells must differ")

    const html = await shared.text()
    const concurrentHtml = await concurrentShared.text()
    assertSafeSharedDocument(shared, html, true)
    assertNoEagerPageSentinel(html, "dev shared shell")
    const initialScriptUrl = html.match(
      /await import\(["']([^"']*shared-dev-[^"']+\.js)["']\)/
    )?.[1]
    assert(initialScriptUrl, "dev shell must import its isolated shared entry")
    assertIncludes(
      concurrentHtml,
      `await import(${JSON.stringify(initialScriptUrl)})`,
      "concurrent dev request uses the same shared entry"
    )
    const initialScript = await fetch(new URL(initialScriptUrl, origin))
    assertEqual(initialScript.status, 200, "dev initial shared entry status")
    assertIncludes(
      initialScript.headers.get("content-type") ?? "",
      "javascript",
      "dev initial shared entry content type"
    )
    assertNoEagerPageSentinel(await initialScript.text(), "initial dev shared entry")

    await writeFile(
      join(root, "app", "page.tsx"),
      'export default function Page() { return <main data-version="two">Updated page</main> }\n'
    )
    const rebuiltScriptUrl = await waitForChangedSharedEntry(origin, initialScriptUrl)
    const rebuiltScript = await fetch(new URL(rebuiltScriptUrl, origin))
    assertEqual(rebuiltScript.status, 200, "rebuilt dev shared entry status")
    assertEqual(
      JSON.stringify((await readdir(sharedDevRoot)).sort()),
      JSON.stringify(["0", "1"]),
      "watch invalidation builds one new shared graph"
    )
    assertNoEagerPageSentinel(await rebuiltScript.text(), "rebuilt dev shared entry")
    assertEqual(
      (await fetch(new URL(initialScriptUrl, origin))).status,
      200,
      "prior dev entry remains available to open pages"
    )
    await assertSharedRoutes(origin)
    assertEqual((await fetch(`${origin}/brand.svg`)).status, 200, "dev root asset")
  } finally {
    await server.stop()
  }
}

async function runProduction(root: string): Promise<void> {
  const outdir = join(root, ".sixb", "dist", "app")
  const app = await createCustomApp({
    rootDir: root,
    authEnabled: false,
    agentRoutes: false,
  })
  const result = await app.build({ outdir })
  assert(result.success, `production build failed: ${result.logs?.join("\n") ?? "unknown"}`)

  const normalHtml = await readFile(join(outdir, "index.html"), "utf-8")
  const sharedHtml = await readFile(join(outdir, "shared-index.html"), "utf-8")
  assertIncludes(normalHtml, 'src="/app-', "normal direct entry")
  assert(!sharedHtml.includes("PUBLIC SHADOW"), "public file must not replace shared shell")
  assert(!/<script\b[^>]*\bsrc=/i.test(sharedHtml), "shared shell has no static script")
  assert(
    !/<link\b[^>]*\brel=["'](?:stylesheet|modulepreload|preload)["']/i.test(sharedHtml),
    "shared shell has no static preload or stylesheet"
  )
  const scrub = sharedHtml.indexOf("history.replaceState")
  const sharedImport = sharedHtml.indexOf('await import("/shared-')
  const stylesheetLoader = sharedHtml.indexOf('link.rel = "stylesheet"')
  assert(scrub >= 0, "production shared shell must scrub its fragment")
  assert(sharedImport > scrub, "production shared JS starts after fragment scrub")
  if (stylesheetLoader >= 0) {
    assert(stylesheetLoader > scrub, "production shared CSS starts after fragment scrub")
  }
  assert(!sharedHtml.includes("shared-main.tsx"), "shared TypeScript path must be rewritten")

  const files = await readdir(outdir)
  const sharedScript = files.find((name) => /^shared-[a-z0-9]+\.js$/.test(name))
  assert(sharedScript, "production build must emit a hashed shared entry")
  const compressibleAssets = files.filter((name) => /\.(?:js|css)$/.test(name))
  assert(compressibleAssets.length > 1, "production build must emit browser assets")
  for (const asset of compressibleAssets) {
    assert(await Bun.file(join(outdir, `${asset}.br`)).exists(), `${asset} Brotli artifact`)
    assert(await Bun.file(join(outdir, `${asset}.gz`)).exists(), `${asset} gzip artifact`)
  }
  assertNoEagerPageSentinel(
    await readFile(join(outdir, sharedScript), "utf-8"),
    "initial production shared entry"
  )

  const port = await getFreePort()
  const server = await app.start({
    host: "127.0.0.1",
    port,
    outdir,
    apiBaseUrl: "https://api.example.test/v1",
  })
  try {
    const origin = `http://127.0.0.1:${port}`
    const shared = await fetch(`${origin}/shared/shr_1/reports/report-1`)
    assertEqual(shared.status, 200, "production shared shell status")
    assertSafeSharedDocument(shared, await shared.text(), false)
    await assertSharedRoutes(origin)

    const asset = await fetch(`${origin}/${sharedScript}`, {
      headers: { "accept-encoding": "br, gzip" },
    })
    assertEqual(asset.status, 200, "shared entry status")
    assertEqual(
      asset.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
      "shared entry cache policy"
    )
    assertEqual(asset.headers.get("content-encoding"), "br", "shared entry compression")
  } finally {
    await server.stop()
  }
}

async function assertSharedRoutes(origin: string): Promise<void> {
  for (const pathname of ["/shared/shr_1", "/shared/shr_1/", "/shared/shr_1/reports/report-1"]) {
    const response = await fetch(`${origin}${pathname}`, { method: "HEAD" })
    assertEqual(response.status, 200, `HEAD ${pathname}`)
    assertEqual(response.headers.get("cache-control"), "no-store", `cache ${pathname}`)
    assertEqual(await response.text(), "", `HEAD body ${pathname}`)
  }

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
    const response = await fetch(`${origin}${pathname}`)
    assertEqual(response.status, 404, `GET ${pathname}`)
    assertEqual(response.headers.get("cache-control"), "no-store", `cache ${pathname}`)
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await fetch(`${origin}/shared/shr_1/reports/report-1`, { method })
    assertEqual(response.status, 404, `${method} shared route`)
    assertEqual(response.headers.get("cache-control"), "no-store", `${method} cache policy`)
  }
}

function assertSafeSharedDocument(response: Response, html: string, development: boolean): void {
  assertEqual(response.headers.get("cache-control"), "no-store", "shared cache policy")
  assertEqual(response.headers.get("referrer-policy"), "no-referrer", "shared referrer policy")
  assertEqual(response.headers.get("x-content-type-options"), "nosniff", "shared nosniff")
  assertEqual(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive",
    "shared robots policy"
  )
  assert(response.headers.get("permissions-policy")?.includes("camera=()"), "permissions policy")
  assertEqual(response.headers.get("link"), null, "shared Link header")

  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)]
  assert(scripts.length > 0, "shared shell must contain an inline bootstrap")
  const nonces = scripts.map((match) => match[1].match(/\bnonce="([^"]+)"/)?.[1])
  assert(nonces.every(Boolean), "every shared script must carry a nonce")
  assertEqual(new Set(nonces).size, 1, "shared script nonce consistency")
  assert(!scripts.some((match) => /\bsrc=/.test(match[1])), "shared scripts must stay inline")
  assert(
    !/<link\b[^>]*\brel=["'](?:stylesheet|modulepreload|preload)["']/i.test(html),
    "shared response must not preload an asset"
  )

  const csp = response.headers.get("content-security-policy") ?? ""
  assertIncludes(csp, `script-src 'nonce-${nonces[0]}'`, "shared CSP nonce")
  for (const directive of [
    "frame-ancestors 'none'",
    "form-action 'none'",
    "manifest-src 'none'",
    "connect-src 'self' https://api.example.test",
  ]) {
    assertIncludes(csp, directive, `shared CSP ${directive}`)
  }
  if (development) {
    assert(!csp.includes("'unsafe-eval'"), "build-like dev shared shell must not allow eval")
  }

  const scrub = html.indexOf("history.replaceState")
  const firstImport = html.indexOf("import(")
  assert(scrub >= 0, "shared response must contain the fragment scrub")
  assert(firstImport > scrub, "shared response must scrub before importing code")
}

function assertNoEagerPageSentinel(content: string, label: string): void {
  assert(
    !content.includes("SIXB_E2E_ORDINARY_PAGE_SENTINEL"),
    `${label} eagerly contains page code`
  )
}

async function prepareProject(root: string): Promise<void> {
  const publicDir = join(root, "app", "public")
  await mkdir(publicDir, { recursive: true })
  await writeFile(
    join(root, "app", "page.tsx"),
    [
      "export default function Page() {",
      '  return <main data-sentinel="SIXB_E2E_ORDINARY_PAGE_SENTINEL">Ordinary page</main>',
      "}",
      "",
    ].join("\n")
  )
  await writeFile(join(root, "app", "globals.css"), ".sixb-e2e-page { color: rgb(1 2 3); }\n")
  await writeFile(join(publicDir, "brand.svg"), "<svg></svg>\n")
  await writeFile(join(publicDir, "shared-index.html"), "PUBLIC SHADOW\n")
  await linkDependencies(root)
}

async function waitForChangedSharedEntry(origin: string, previousUrl: string): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    await Bun.sleep(25)
    const html = await (await fetch(`${origin}/shared/shr_1/reports/report-1`)).text()
    const currentUrl = html.match(/await import\(["']([^"']*shared-dev-[^"']+\.js)["']\)/)?.[1]
    if (currentUrl && currentUrl !== previousUrl) return currentUrl
  }
  throw new Error("Shared development bundle did not rebuild within 5000ms.")
}

async function linkDependencies(root: string): Promise<void> {
  const appPackageRoot = resolve(import.meta.dir, "../..")
  const dependencies = new Map<string, string>([
    ["@sixb/client", resolve(appPackageRoot, "../client")],
    ["@tanstack/react-query", join(appPackageRoot, "node_modules", "@tanstack/react-query")],
    ["react", join(appPackageRoot, "node_modules", "react")],
    ["react-dom", join(appPackageRoot, "node_modules", "react-dom")],
    ["react-router-dom", join(appPackageRoot, "node_modules", "react-router-dom")],
  ])

  for (const [name, source] of dependencies) {
    const destination = join(root, "node_modules", ...name.split("/"))
    await mkdir(dirname(destination), { recursive: true })
    await symlink(source, destination, "dir")
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`)
  }
}

function assertIncludes(actual: string, expected: string, label: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`
    )
  }
}
