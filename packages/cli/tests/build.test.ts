import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

function runBuildEntry(
  entry: string,
  outdir: string
): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "build", "--entry", entry, "--outdir", outdir],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
  }
}

describe("pario build", () => {
  const tempDirs: string[] = []
  const exampleEntry = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "examples",
    "roku-tv",
    "pario.config.ts"
  )

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        await rm(dir, { recursive: true, force: true })
      }
    }
  })

  test("builds the custom app from the entry project root", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pario-cli-build-"))
    tempDirs.push(tempDir)
    const outdir = join(tempDir, "dist")

    const result = runBuildEntry(exampleEntry, outdir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Built")

    await stat(join(outdir, "pario.config.js"))
    await stat(join(outdir, "app", "index.html"))

    const html = await readFile(join(outdir, "app", "index.html"), "utf-8")
    expect(html).toContain('<div id="root"></div>')
  })
})
