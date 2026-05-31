import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  builtAtlasOutdir,
  builtSentinelOutdir,
  resolveProductionPaths,
} from "../src/lib/production"

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

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe("pario command dispatch", () => {
  test("lists split production commands in help", () => {
    const result = runCli(["help"])

    expect(result.exitCode).toBe(0)
    for (const command of [
      "api",
      "atlas",
      "sentinel",
      "app",
      "scheduler",
      "orchestrator",
      "functions",
      "rules",
      "worker",
    ]) {
      expect(result.stdout).toContain(command)
    }
    expect(result.stdout).toContain("pario worker pipeline")
    expect(result.stderr).toBe("")
  })

  test("dispatches a split production command instead of treating it as unknown", () => {
    const result = runCli(["api", "--entry", "fixtures/missing/pario.config.ts"])

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
    const staleCommandFiles = [
      "docs/concepts/pipeline.md",
      "docs/concepts/workflows.md",
      "examples/acme-corp/package.json",
      "examples/panasonic-ac/package.json",
      "examples/roku-tv/package.json",
    ]

    for (const file of staleCommandFiles) {
      const source = await readFile(join(repoRoot, file), "utf-8")

      expect(source).not.toContain("pario start")
      expect(source).not.toContain("pario worker --worker")
      expect(source).not.toContain("bun ../../packages/cli/src/index.tsx start")
    }
  })
})

describe("production asset paths", () => {
  test("resolves default .pario/dist assets from the source project root", async () => {
    const projectRoot = resolve(import.meta.dir, "fixtures", "valid-project")
    const paths = await resolveProductionPaths(
      join(projectRoot, ".pario", "dist", "pario.config.js")
    )

    expect(paths.projectRoot).toBe(projectRoot)
    expect(paths.buildOutdir).toBe(join(projectRoot, ".pario", "dist"))
    expect(builtAtlasOutdir(paths.buildOutdir)).toBe(join(projectRoot, ".pario", "dist", "atlas"))
    expect(builtSentinelOutdir(paths.buildOutdir)).toBe(
      join(projectRoot, ".pario", "dist", "sentinel")
    )
  })

  test("resolves custom build assets next to the built entry", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pario-cli-production-"))
    tempDirs.push(tempDir)
    const outdir = join(tempDir, "dist")
    await mkdir(join(outdir, "atlas"), { recursive: true })
    await mkdir(join(outdir, "sentinel"), { recursive: true })

    const paths = await resolveProductionPaths(join(outdir, "pario.config.js"))

    expect(paths.projectRoot).toBe(outdir)
    expect(paths.buildOutdir).toBe(outdir)
    expect(builtAtlasOutdir(paths.buildOutdir)).toBe(join(outdir, "atlas"))
    expect(builtSentinelOutdir(paths.buildOutdir)).toBe(join(outdir, "sentinel"))
  })
})
