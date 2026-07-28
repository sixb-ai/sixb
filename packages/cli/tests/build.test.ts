import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

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

    // Exactly one entry: the Atlas build splits, and chunks are named `chunk-*` so they can never
    // be mistaken for it.
    expect(atlasAssets.filter((file) => /^atlas-[^.]+\.js$/.test(file))).toHaveLength(1)
    expect(atlasAssets.filter((file) => /^atlas-[^.]+\.css$/.test(file))).toHaveLength(1)
    expect(atlasAssets.some((file) => /^chunk-.+\.js$/.test(file))).toBe(true)

    const html = await readFile(join(outdir, "app", "index.html"), "utf-8")
    expect(html).toContain('<div id="root"></div>')
  })

  test("does not overwrite custom app files watched by the dev server", async () => {
    const tempDir = await mkdtemp(join(dirname(exampleEntry), ".tmp-sixb-cli-build-isolation-"))
    tempDirs.push(tempDir)
    const appDir = join(tempDir, "app")
    const devGeneratedDir = join(tempDir, ".sixb", "generated")
    const entry = join(tempDir, "sixb.config.ts")
    const outdir = join(tempDir, "dist")
    await mkdir(appDir, { recursive: true })
    await mkdir(devGeneratedDir, { recursive: true })
    await writeFile(entry, "export default {}\n")
    await writeFile(join(appDir, "page.tsx"), "export default function Page() { return null }\n")

    const devFiles = new Map([
      ["index.html", "dev index with http://localhost:3000\n"],
      ["index.sixb-bundle.html", "dev HTML bundle entry\n"],
      ["main.tsx", "dev main entry\n"],
      ["routes.ts", "dev routes\n"],
      ["app.webmanifest", "dev manifest\n"],
    ])
    for (const [name, content] of devFiles) {
      await writeFile(join(devGeneratedDir, name), content)
    }

    const result = runBuildEntry(entry, outdir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    await stat(join(outdir, "app", "index.html"))
    for (const [name, content] of devFiles) {
      expect(await readFile(join(devGeneratedDir, name), "utf-8")).toBe(content)
    }
    await stat(join(tempDir, ".sixb", "build", "app", "index.html"))
  }, 30_000)

  test("externalizes package dependencies when bundling runtime config", async () => {
    const repoRoot = resolve(import.meta.dir, "..", "..", "..")
    const tempDir = await mkdtemp(join(repoRoot, ".tmp-sixb-cli-build-packages-"))
    tempDirs.push(tempDir)
    const entry = join(tempDir, "sixb.config.ts")
    const outdir = join(tempDir, "dist")

    await writeFile(
      entry,
      [
        'import { DuckLakeStorage } from "@sixb/ducklake"',
        'import { sftp } from "@sixb/connector-sftp"',
        "",
        "export const duckLakeStorageConstructor = DuckLakeStorage",
        'export const sftpAdapter = sftp({ host: "example.com", username: "demo" })',
      ].join("\n")
    )

    const result = runBuildEntry(entry, outdir)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const builtEntry = join(outdir, "sixb.config.js")
    await stat(builtEntry)

    const builtJs = await readFile(builtEntry, "utf-8")
    expect(builtJs).toContain('"@sixb/ducklake"')
    expect(builtJs).toContain('"@sixb/connector-sftp"')
    expect(builtJs).not.toContain("@duckdb/node-api")
    expect(builtJs).not.toContain("sshcrypto")

    const outputFiles = await readdir(outdir)
    expect(outputFiles.some((file) => file.endsWith(".node"))).toBe(false)
  })
})
