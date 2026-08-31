import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const repoRoot = resolve(packageRoot, "..", "..")

describe("custom app production browser bundle", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  test("executes subclass-based package exports and mounts React", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-app-browser-build-"))
    roots.push(root)
    await mkdir(join(root, "app"), { recursive: true })
    await linkFixtureDependencies(root)
    await writeFile(
      join(root, "app", "page.tsx"),
      `import { AsYouType, parsePhoneNumberFromString } from "libphonenumber-js"

export default function Page() {
  const formatted = new AsYouType("US").input("2125551234")
  const parsed = parsePhoneNumberFromString("2125551234", "US")?.number
  return <main data-testid="phone-result">{formatted}|{parsed}</main>
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
  agentRoutes: false,
})
const result = await app.build()
if (!result.success) throw new Error((result.logs ?? []).join("\\n"))
`
    )
    const build = await runBunScript(buildScript, root)
    expect(build.exitCode, build.stderr).toBe(0)

    const outdir = join(root, ".sixb", "dist", "app")
    const html = await readFile(join(outdir, "index.html"), "utf-8")
    const entryFile = html.match(/src="\/(app-[a-z0-9]+\.js)"/)?.[1]
    expect(entryFile).toBeDefined()
    expect(html).toContain('class="sixb-loading-shell"')

    const executeScript = join(root, "execute.ts")
    await writeFile(
      executeScript,
      `import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { GlobalWindow } from "happy-dom"

const outdir = ${JSON.stringify(outdir)}
const html = await readFile(join(outdir, "index.html"), "utf-8")
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
console.log(result.textContent)
`
    )

    const execution = await runBunScript(executeScript, root)
    expect(execution.exitCode, execution.stderr).toBe(0)
    expect(execution.stdout.trim()).toBe("(212) 555-1234|+12125551234")
    // Regression proof: on Bun 1.3.14, restoring the resolver hook's old /^\.\.?\// filter
    // makes this child fail with an undefined superclass before React can mount, while the build
    // child still exits successfully.
  }, 30_000)
})

async function linkFixtureDependencies(root: string): Promise<void> {
  const dependencies = new Map([
    ["react", join(packageRoot, "node_modules", "react")],
    ["react-dom", join(packageRoot, "node_modules", "react-dom")],
    ["react-router-dom", join(packageRoot, "node_modules", "react-router-dom")],
    ["@tanstack/react-query", join(packageRoot, "node_modules", "@tanstack", "react-query")],
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
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", scriptPath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, 15_000)
  const exitCode = await proc.exited
  clearTimeout(timeout)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  if (timedOut) {
    throw new Error(`Timed out running ${scriptPath}\n${stderr}`)
  }
  return { exitCode, stdout, stderr }
}
