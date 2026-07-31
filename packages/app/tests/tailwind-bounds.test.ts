import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTailwindCssCompiler } from "../src/tailwind"

// These drive a real child process through the real spawn path, so they live next to the
// other Tailwind tests but keep their own bounds well under the unit suite's tolerance.

const tempRoots: string[] = []

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

/**
 * Stands in for `@tailwindcss/cli` so a build's behaviour can be chosen.
 *
 * `resolveTailwindCliEntry` looks for `@tailwindcss/cli/package.json` and runs
 * `dist/index.mjs` beside it, so a fake package in the resolution root is enough — no
 * need to make the real CLI misbehave.
 */
async function projectWithFakeTailwind(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sixb-tailwind-"))
  tempRoots.push(root)

  const cliDir = join(root, "node_modules", "@tailwindcss", "cli")
  await mkdir(join(cliDir, "dist"), { recursive: true })
  await writeFile(
    join(cliDir, "package.json"),
    JSON.stringify({ name: "@tailwindcss/cli", version: "0.0.0-fake" })
  )
  await writeFile(join(cliDir, "dist", "index.mjs"), source)
  await writeFile(join(root, "globals.css"), '@import "tailwindcss";\n')

  return root
}

function compilerIn(root: string, timeoutMs: number) {
  return createTailwindCssCompiler({
    inputPath: join(root, "globals.css"),
    outputPath: join(root, "out", "app.css"),
    cwd: root,
    resolveFrom: root,
    label: "[Test]",
    timeoutMs,
  })
}

describe("createTailwindCssCompiler bounds", () => {
  test("kills a build that never finishes and says so", async () => {
    // Unbounded, a wedged CLI held `sixb dev` open forever, and `stop()` awaited the same
    // build — so shutdown hung with it and the only way out was killing the terminal.
    const root = await projectWithFakeTailwind("await new Promise(() => {})\n")
    const compiler = compilerIn(root, 250)

    await expect(compiler.compile()).rejects.toThrow(
      "[Test] Tailwind CSS build did not finish within 250ms and was killed."
    )

    await compiler.stop()
  }, 10_000)

  test("stop() does not wait out the timeout for a build in flight", async () => {
    const root = await projectWithFakeTailwind("await new Promise(() => {})\n")
    const compiler = compilerIn(root, 30_000)

    const build = compiler.compile()
    const startedAt = Date.now()
    await compiler.stop()

    // Well under the 30s bound: `stop()` kills the child rather than waiting for it. The
    // build it discards resolves quietly — an error logged on every shutdown that happened
    // to catch a rebuild is noise, not information.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    await expect(build).resolves.toBeUndefined()
  }, 10_000)

  test("reports a large failure output whole", async () => {
    // 512 KB is past any OS pipe buffer, which is the size at which a child blocks on write
    // if nobody is reading. Bun buffers this pipe internally so it does not actually block —
    // verified by running this against the old read-after-exit ordering, which passed — and
    // the assertion that stands is the one worth keeping: a big stderr reaches the message
    // instead of arriving empty or truncated.
    const root = await projectWithFakeTailwind(
      'process.stderr.write("x".repeat(512 * 1024))\nprocess.exit(1)\n'
    )
    const compiler = compilerIn(root, 5_000)

    await expect(compiler.compile()).rejects.toThrow("[Test] Tailwind CSS build failed: xxx")

    await compiler.stop()
  }, 15_000)

  test("a build that succeeds stays silent", async () => {
    const root = await projectWithFakeTailwind('process.stderr.write("a warning\\n")\n')
    const compiler = compilerIn(root, 5_000)

    await expect(compiler.compile()).resolves.toBeUndefined()

    await compiler.stop()
  }, 10_000)
})
