import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

async function runDbCommand(subcommand: "migrate"): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  logEntries: Array<Record<string, unknown>>
}> {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", "db-project", "pario.config.ts")
  const tempDir = await mkdtemp(join(tmpdir(), "pario-cli-db-"))
  const logPath = join(tempDir, "operations.log")
  tempDirs.push(tempDir)

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "db", subcommand, "--entry", fixtureEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      PARIO_CLI_TEST_LOG: logPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const logSource = await readFile(logPath, "utf-8").catch(() => "")

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
    logEntries: logSource
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

describe("pario db", () => {
  test("runs adapter migrations for the configured runtime", async () => {
    const result = await runDbCommand("migrate")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Database migrations complete")
    expect(result.stdout).toContain("Storage")
    expect(result.stdout).toContain("migrated")
    expect(result.logEntries).toEqual([{ type: "storage.migrate" }])
  })
})
