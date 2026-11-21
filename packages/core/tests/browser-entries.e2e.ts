import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const BUNDLE_BUDGET_MS = 60_000
/** An import of Node's or Bun's modules, which `bundleForBrowser` leaves for the browser to fail. */
const SERVER_IMPORT = /from\s*"(node|bun):|require\("(node|bun):/

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * Bundles a module of `src` for the browser in a child process, and says why it could not. Bun
 * fills in Node's modules for a browser bundle, so they stay out of it, as imports `bundle`, its
 * text, still names: what a browser could not load.
 */
async function bundleForBrowser(
  module: string
): Promise<{ exitCode: number; stderr: string; bundle: string }> {
  const root = await mkdtemp(join(tmpdir(), "sixb-core-browser-"))
  roots.push(root)
  const entry = join(root, "entry.ts")
  await writeFile(
    entry,
    `import * as module from ${JSON.stringify(join(packageRoot, "src", module))}
console.log(Object.keys(module).length)
`
  )
  const script = join(root, "build.ts")
  const output = join(root, "bundle.js")
  await writeFile(
    script,
    `const result = await Bun.build({
  entrypoints: [${JSON.stringify(entry)}],
  target: "browser",
  external: ["node:*", "bun:*"],
})
if (!result.success) {
  console.error(result.logs.map(String).join("\\n"))
  process.exit(1)
}
await Bun.write(${JSON.stringify(output)}, result.outputs[0])
`
  )

  const proc = Bun.spawn([process.execPath, "run", script], {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderrPromise = new Response(proc.stderr).text()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, BUNDLE_BUDGET_MS)
  const exitCode = await proc.exited
  clearTimeout(timeout)
  const stderr = await stderrPromise

  expect(timedOut, `Bun.build did not finish within ${BUNDLE_BUDGET_MS}ms`).toBe(false)
  const bundle = exitCode === 0 ? await Bun.file(output).text() : ""
  return { exitCode, stderr, bundle }
}

describe("@sixb/core/security in the browser", () => {
  // An app layout imports the project's group files to decide who sees which screens, so this entry
  // and everything it reaches must bundle for the browser. Regression proof: add
  // `export { createSixb } from "../runtime/create"` to src/security/public.ts and the bundle
  // imports the runtime's Node modules.
  test("bundles for the browser", async () => {
    const { exitCode, stderr, bundle } = await bundleForBrowser("security/public.ts")
    expect(exitCode, stderr).toBe(0)
    expect(bundle.match(SERVER_IMPORT)?.[0]).toBeUndefined()
  }, 90_000)
})

describe("a video's composition in the browser", () => {
  // The app's player and editor read a video's composition as publishing does. Regression proof:
  // import `sceneRenderKey` from "../publish/video" in src/artifacts/video/composition.ts, and the
  // bundle imports node:crypto; read an attribute with HTMLRewriter, and it names Bun's global.
  test("bundles for the browser, needing nothing of Node or Bun", async () => {
    const { exitCode, stderr, bundle } = await bundleForBrowser("artifacts/video/composition.ts")
    expect(exitCode, stderr).toBe(0)
    expect(bundle.match(SERVER_IMPORT)?.[0]).toBeUndefined()
    expect(bundle.match(/\bHTMLRewriter\b|\bBun\./)?.[0]).toBeUndefined()
  }, 90_000)
})
