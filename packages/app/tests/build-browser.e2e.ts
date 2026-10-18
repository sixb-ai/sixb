import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const repoRoot = resolve(packageRoot, "..", "..")

describe("custom app production browser bundle", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test("mounts React with package exports and public env captured before module evaluation", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-app-browser-build-"))
    roots.push(root)
    await mkdir(join(root, "app"), { recursive: true })
    await linkFixtureDependencies(root)
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ extends: join(repoRoot, "tsconfig.json") })
    )
    await writeFile(
      join(root, "app", "page.tsx"),
      `import { publicEnv } from "@sixb/app"
import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js"

const publicValue = publicEnv.SIXB_PUBLIC_TEST_KEY
const missing = publicEnv.SIXB_PUBLIC_MISSING === undefined

export default function Page() {
  const formatted = new AsYouType("US").input("2125551234")
  const parsed = parsePhoneNumberFromString("2125551234", "US")?.number
  return <main data-testid="phone-result">{formatted}|{parsed}|{publicValue}|{String(missing)}</main>
}
`
    )

    const buildScript = join(root, "build.ts")
    await writeFile(
      buildScript,
      `import { createCustomApp } from ${JSON.stringify(join(packageRoot, "src", "createCustomApp.ts"))}

const app = await createCustomApp({
  rootDir: ${JSON.stringify(root)},
  apiBaseUrl: "http://127.0.0.1:3000",
  authEnabled: false,
  builtInPages: false,
})
const result = await app.build()
if (!result.success) throw new Error((result.logs ?? []).join("\\n"))
`
    )
    const build = await runBunScript(buildScript, root, "build-time-sentinel")
    expect(build.exitCode, build.stderr).toBe(0)

    const outdir = join(root, ".sixb", "dist", "app")
    const html = await readFile(join(outdir, "index.html"), "utf-8")
    const entryFile = html.match(/src="\/(app-[a-z0-9]+\.js)"/)?.[1]
    expect(entryFile).toBeDefined()
    expect(html).toContain('class="sixb-loading-shell"')

    for (const file of await readdir(outdir)) {
      if (!/\.(html|js|map)$/.test(file)) continue
      const content = await readFile(join(outdir, file), "utf-8")
      expect(content).not.toContain("build-time-sentinel")
      expect(content).not.toContain("private-env-sentinel")
    }

    const executeScript = join(root, "execute.ts")
    await writeFile(
      executeScript,
      `import { createCustomApp } from ${JSON.stringify(join(packageRoot, "src", "createCustomApp.ts"))}
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { GlobalWindow } from "happy-dom"

const outdir = ${JSON.stringify(outdir)}
const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/api/project"
      ? Response.json({ id: "browser", locale: "fr-FR", timeZone: "Europe/Paris" })
      : new Response(null, { status: 404 }),
})
const app = await createCustomApp({ rootDir: ${JSON.stringify(root)}, authEnabled: false })
const server = await app.start({
  host: "127.0.0.1",
  port: 0,
  apiBaseUrl: "http://127.0.0.1:" + api.port,
})
let html
try {
  html = await (await fetch(server.url)).text()
} finally {
  await server.stop()
}
const runtime = html.match(/window\\.__SIXB_RUNTIME__ = (.*);<\\/script>/)?.[1]
if (!runtime) throw new Error("Built app runtime config is missing")

const window = new GlobalWindow({ url: "http://127.0.0.1/" })
Object.assign(window, { __SIXB_RUNTIME__: JSON.parse(runtime) })
window.document.body.innerHTML = '<div id="root">loading</div>'
Object.assign(globalThis, {
  window,
  self: window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  history: window.history,
  Node: window.Node,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
})

await import(pathToFileURL(join(outdir, ${JSON.stringify(entryFile)})).href)
await window.happyDOM.waitUntilComplete()
await new Promise((resolve) => window.setTimeout(resolve, 0))

const result = window.document.querySelector('[data-testid="phone-result"]')
if (!result) throw new Error("React did not replace the production loading shell")
for (let attempt = 0; attempt < 100 && !window.document.documentElement.lang; attempt += 1) {
  await new Promise((resolve) => window.setTimeout(resolve, 10))
}
await api.stop(true)
console.log(result.textContent + "|" + window.document.documentElement.lang)
`
    )

    for (const value of ["runtime-key", "restarted-key"]) {
      const execution = await runBunScript(executeScript, root, value)
      expect(execution.exitCode, execution.stderr).toBe(0)
      expect(execution.stdout.trim()).toBe(`(212) 555-1234|+12125551234|${value}|true|fr-FR`)
    }
    // Regression proof for the document language: drop the project fetch from the generated
    // startApp; the document keeps no language because the HTML was built without the project.
    // Regression proof for public env: remove the publicEnv export or runtime read and this
    // fails to bundle or loses the value captured before the page module evaluates.
    // On Bun 1.4.2, removing sideEffects: false also breaks this build: the bundle keeps the
    // agent exports of @sixb/app and splits them into a chunk this harness cannot load.
    // Regression proof: on Bun 1.3.14, restoring the resolver hook's old /^\.\.?\// filter
    // makes this child fail with an undefined superclass before React can mount, while the build
    // child still exits successfully.
  }, 30_000)
})

describe("custom app Tailwind build", () => {
  // Inside the repo so the generated entry's react/react-router imports and the Tailwind CLI
  // resolve from the workspace's node_modules.
  let tempRoot = ""

  afterEach(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  test("compiles the app's Tailwind CSS fresh with the built-in pages and bundles it", async () => {
    tempRoot = await mkdtemp(join(import.meta.dir, "tmp-tailwind-build-"))
    for (const name of [
      "@tailwindcss/cli",
      "tailwindcss",
      "react",
      "react-dom",
      "react-router-dom",
      "@tanstack/react-query",
      "@sixb/app",
      "@sixb/client",
      "@sixb/ui",
    ]) {
      const target = join(tempRoot, "node_modules", ...name.split("/"))
      await mkdir(dirname(target), { recursive: true })
      await symlink(dirname(Bun.resolveSync(`${name}/package.json`, packageRoot)), target)
    }
    const appDir = join(tempRoot, "app")
    await mkdir(appDir, { recursive: true })
    await writeFile(
      join(appDir, "globals.css"),
      [
        '@import "@sixb/ui/globals.css";',
        '@source "./**/*.tsx";',
        ":root { --background: #123456; }",
        "",
      ].join("\n")
    )
    await writeFile(
      join(appDir, "page.tsx"),
      'export default function Page() { return <main className="line-through">ok</main> }\n'
    )
    // A leftover chunk from a previous build must not survive: the outdir is build-owned and gets
    // cleared, or stale hashed assets accumulate forever.
    const staleChunkPath = join(tempRoot, ".sixb", "dist", "app", "chunk-stale123.js")
    await mkdir(dirname(staleChunkPath), { recursive: true })
    await writeFile(staleChunkPath, "console.log('stale')\n")

    const buildScript = join(tempRoot, "run-build.ts")
    await writeFile(
      buildScript,
      `import { createCustomApp } from ${JSON.stringify(join(packageRoot, "src", "createCustomApp.ts"))}
const app = await createCustomApp({ rootDir: ${JSON.stringify(tempRoot)}, apiBaseUrl: "http://127.0.0.1:3000" })
const result = await app.build()
if (!result.success) throw new Error((result.logs ?? []).join("\\n"))
`
    )
    const build = await runBunScript(buildScript, tempRoot, "unused", 60_000)
    expect(build.exitCode, build.stderr).toBe(0)

    // The compiled stylesheet lands under .sixb/generated, not app/. Canary classes, one per
    // scanned source — proves Tailwind compiled the app's own page plus the linked component
    // libraries, not just one of them. `line-through` is the app page, `max-h-60` comes only from
    // the agent's components, `scroll-mt-4` only from the built-in pages. (Repoint these if a class
    // is removed from its source rather than asserting a class that no longer exists.)
    const generatedCss = await readFile(join(tempRoot, ".sixb", "generated", "app.css"), "utf-8")
    expect(generatedCss).toContain("line-through")
    expect(generatedCss).toContain("max-h-60")
    expect(generatedCss).toContain("scroll-mt-4")
    expect(generatedCss.lastIndexOf("--background: #123456")).toBeGreaterThan(
      generatedCss.lastIndexOf("--background: #fafafa")
    )

    const generatedRuntime = await readFile(
      join(tempRoot, ".sixb", "generated", "app-runtime.tsx"),
      "utf-8"
    )
    expect(generatedRuntime).toContain('import "./app.css"')
    expect(generatedRuntime).not.toContain('import "./framework.css"')

    // The bundled output ships the compiled utility, proving the generated entry imported the
    // compiled CSS rather than the raw Tailwind source.
    const outdir = join(tempRoot, ".sixb", "dist", "app")
    const cssBundles: string[] = []
    for await (const path of new Bun.Glob("*.css").scan({ cwd: outdir, absolute: true })) {
      cssBundles.push(await readFile(path, "utf-8"))
    }
    expect(cssBundles.join("\n")).toContain("line-through")
    expect(cssBundles.join("\n")).not.toContain("@source")

    const builtHtml = await readFile(join(outdir, "index.html"), "utf-8")
    expect(builtHtml.match(/src="\/(app-[a-z0-9]+\.js)"/)?.[1]).toBeDefined()
    const sharedHtml = await readFile(join(outdir, "shared-index.html"), "utf-8")
    expect(sharedHtml).toContain("async loadAppStyles()")
    expect(sharedHtml).toContain('link.addEventListener("load", resolve, { once: true })')
    expect(sharedHtml).toContain('link.addEventListener("error", resolve, { once: true })')
    expect(sharedHtml.indexOf("await Promise.all(")).toBeLessThan(
      sharedHtml.indexOf("document.head.append(link)")
    )
    const javascriptFiles = await Array.fromAsync(new Bun.Glob("*.js").scan({ cwd: outdir }))
    expect(javascriptFiles.length).toBeGreaterThan(1)
    const hasDynamicChunk = await Promise.all(
      javascriptFiles.map(async (file) =>
        (await readFile(join(outdir, file), "utf-8")).includes('import("/chunk-')
      )
    )
    expect(hasDynamicChunk).toContain(true)
    // Regression proof: restoring the HTML entry without `splitting` emits one ~10 MB JavaScript
    // file for this fixture (all Shiki grammars) and fails both assertions above.

    expect(await Bun.file(staleChunkPath).exists()).toBe(false)
  }, 90_000)
})

async function linkFixtureDependencies(root: string): Promise<void> {
  const dependencies = new Map([
    ["react", join(packageRoot, "node_modules", "react")],
    ["react-dom", join(packageRoot, "node_modules", "react-dom")],
    ["react-router-dom", join(packageRoot, "node_modules", "react-router-dom")],
    ["@tanstack/react-query", join(packageRoot, "node_modules", "@tanstack", "react-query")],
    ["@sixb/app", packageRoot],
    ["@sixb/client", join(repoRoot, "packages", "client")],
    ["happy-dom", join(packageRoot, "node_modules", "happy-dom")],
    ["libphonenumber-js", join(packageRoot, "node_modules", "libphonenumber-js")],
  ])

  for (const [name, source] of dependencies) {
    const target = join(root, "node_modules", ...name.split("/"))
    await mkdir(dirname(target), { recursive: true })
    await symlink(source, target, "dir")
  }
}

async function runBunScript(
  scriptPath: string,
  cwd: string,
  publicValue: string,
  budgetMs = 15_000
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", scriptPath], {
    cwd,
    env: {
      ...process.env,
      SIXB_PUBLIC_TEST_KEY: publicValue,
      SIXB_PRIVATE_TEST_KEY: "private-env-sentinel",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, budgetMs)
  const exitCode = await proc.exited
  clearTimeout(timeout)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  if (timedOut) {
    throw new Error(`Timed out running ${scriptPath}\n${stderr}`)
  }
  return { exitCode, stdout, stderr }
}
