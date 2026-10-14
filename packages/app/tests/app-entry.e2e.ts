import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const BUNDLE_BUDGET_MS = 60_000

describe("@sixb/app browser entries", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  // App code imports any part of `@sixb/app`, the generated routes import `@sixb/app/pages`, and
  // dev bundles keep whole modules, so both must bundle for the browser in full rather than only
  // through what one page uses. The CLI's tooling lives in `@sixb/app/server` for this reason.
  // Regression proof: add `export { createCustomApp } from "./createCustomApp"` to src/index.ts
  // and this build fails on the tooling's server-only imports.
  test("bundles for the browser in full", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-app-entry-"))
    roots.push(root)
    const entry = join(root, "entry.ts")
    await writeFile(
      entry,
      `import * as app from ${JSON.stringify(join(packageRoot, "src", "index.ts"))}
import * as pages from ${JSON.stringify(join(packageRoot, "src", "pages.ts"))}
console.log(Object.keys(app).length + Object.keys(pages).length)
`
    )
    const script = join(root, "build.ts")
    await writeFile(
      script,
      `const result = await Bun.build({ entrypoints: [${JSON.stringify(entry)}], target: "browser" })
if (!result.success) {
  console.error(result.logs.map(String).join("\\n"))
  process.exit(1)
}
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
    expect(exitCode, stderr).toBe(0)
  }, 90_000)
})
