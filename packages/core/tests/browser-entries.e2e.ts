import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const BUNDLE_BUDGET_MS = 60_000

describe("@sixb/core/security in the browser", () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  // An app layout imports the project's group files to decide who sees which screens, so this entry
  // and everything it reaches must bundle for the browser. Regression proof: add
  // `export { createSixb } from "../runtime/create"` to src/security/public.ts and this build fails
  // on the runtime's server-only imports.
  test("bundles for the browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "sixb-core-security-"))
    roots.push(root)
    const entry = join(root, "entry.ts")
    await writeFile(
      entry,
      `import * as security from ${JSON.stringify(join(packageRoot, "src", "security", "public.ts"))}
console.log(Object.keys(security).length)
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
