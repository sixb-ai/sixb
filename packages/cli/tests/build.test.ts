import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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

describe("sixb build", () => {
  const tempDirs: string[] = []
  const exampleEntry = resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "examples",
    "roku-tv",
    "sixb.config.ts"
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
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-build-"))
    tempDirs.push(tempDir)
    const outdir = join(tempDir, "dist")

    const result = runBuildEntry(exampleEntry, outdir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Built")

    await stat(join(outdir, "sixb.config.js"))
    await stat(join(outdir, "app", "index.html"))
    const atlasAssets = await readdir(join(outdir, "atlas"))

    expect(atlasAssets.some((file) => /^main-[^.]+\.js$/.test(file))).toBe(true)
    expect(atlasAssets.some((file) => /^main-[^.]+\.css$/.test(file))).toBe(true)

    const html = await readFile(join(outdir, "app", "index.html"), "utf-8")
    expect(html).toContain('<div id="root"></div>')
  })

  test("externalizes DuckDB native bindings when bundling runtime config", async () => {
    const repoRoot = resolve(import.meta.dir, "..", "..", "..")
    const tempDir = await mkdtemp(join(repoRoot, ".tmp-sixb-cli-build-duckdb-"))
    tempDirs.push(tempDir)
    const entry = join(tempDir, "sixb.config.ts")
    const outdir = join(tempDir, "dist")

    await writeFile(
      entry,
      [
        'import { DuckLakeStorage } from "@sixb/ducklake"',
        "",
        "export const duckLakeStorageConstructor = DuckLakeStorage",
      ].join("\n")
    )

    const result = runBuildEntry(entry, outdir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const builtEntry = join(outdir, "sixb.config.js")
    await stat(builtEntry)

    const builtJs = await readFile(builtEntry, "utf-8")
    expect(builtJs).toContain('"@sixb/ducklake"')
    expect(builtJs).not.toContain("@duckdb/node-api")
  })
})
