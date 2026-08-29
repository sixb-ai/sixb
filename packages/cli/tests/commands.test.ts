import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { builtAtlasOutdir, hasBuiltCustomApp, resolveProductionPaths } from "../src/lib/production"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

function runCli(args: readonly string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, ...args],
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

const tempDirs: string[] = []

async function collectFiles(
  directory: string,
  predicate: (path: string) => boolean
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path, predicate)))
      continue
    }

    if (entry.isFile() && predicate(path)) {
      files.push(path)
    }
  }

  return files.sort()
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe("sixb command dispatch", () => {
  test("lists split production commands in help", () => {
    const result = runCli(["help"])

    expect(result.exitCode).toBe(0)
    for (const command of ["api", "atlas", "app", "scheduler", "orchestrator", "rules", "worker"]) {
      expect(result.stdout).toContain(command)
    }
    expect(result.stdout).toContain("sixb worker pipeline")
    expect(result.stderr).toBe("")
  })

  test("dispatches a split production command instead of treating it as unknown", () => {
    const result = runCli(["api", "--entry", "fixtures/missing/sixb.config.ts"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).not.toContain("Unknown command: api")
    expect(result.stderr).toBe("")
  })

  test("does not expose the removed production supervisor command", () => {
    const result = runCli(["start"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Unknown command: start")
    expect(result.stderr).toBe("")
  })

  test("does not document removed production command shapes", async () => {
    const staleCommands = [
      "sixb start",
      "sixb worker --worker",
      "bun ../../packages/cli/src/index.tsx start",
    ]

    const staleCommandFiles = [
      join(repoRoot, "README.md"),
      join(repoRoot, "packages/cli/README.md"),
      ...(await collectFiles(join(repoRoot, "docs"), (file) => file.endsWith(".md"))),
      ...(await collectFiles(join(repoRoot, "examples"), (file) => file.endsWith("package.json"))),
    ]

    for (const file of staleCommandFiles) {
      const source = await readFile(file, "utf-8")

      for (const command of staleCommands) {
        expect(source).not.toContain(command)
      }
    }
  })
})

describe("production asset paths", () => {
  test("requires both ordinary and shared shells for a built custom app", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-production-app-"))
    tempDirs.push(tempDir)

    expect(await hasBuiltCustomApp(tempDir)).toBe(false)
    await writeFile(join(tempDir, "index.html"), "ordinary")
    expect(await hasBuiltCustomApp(tempDir)).toBe(false)
    await writeFile(join(tempDir, "shared-index.html"), "shared")
    expect(await hasBuiltCustomApp(tempDir)).toBe(true)
  })

  test("resolves default .sixb/dist assets from the source project root", async () => {
    const projectRoot = resolve(import.meta.dir, "fixtures", "valid-project")
    const paths = await resolveProductionPaths(join(projectRoot, ".sixb", "dist", "sixb.config.js"))

    expect(paths.projectRoot).toBe(projectRoot)
    expect(paths.buildOutdir).toBe(join(projectRoot, ".sixb", "dist"))
    expect(builtAtlasOutdir(paths.buildOutdir)).toBe(join(projectRoot, ".sixb", "dist", "atlas"))
  })

  test("resolves custom build assets next to the built entry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-production-"))
    tempDirs.push(tempDir)
    const outdir = join(tempDir, "dist")
    await mkdir(join(outdir, "atlas"), { recursive: true })

    const paths = await resolveProductionPaths(join(outdir, "sixb.config.js"))

    expect(paths.projectRoot).toBe(outdir)
    expect(paths.buildOutdir).toBe(outdir)
    expect(builtAtlasOutdir(paths.buildOutdir)).toBe(join(outdir, "atlas"))
  })
})
