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

async function runLakeCommand(
  subcommand: "check" | "cleanup",
  options: {
    drift?: boolean
    noMaintenance?: boolean
    args?: readonly string[]
  } = {}
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  logEntries: Array<Record<string, unknown>>
}> {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", "lake-project", "sixb.config.ts")
  const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-lake-"))
  const logPath = join(tempDir, "operations.log")
  tempDirs.push(tempDir)

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "lake", subcommand, "--entry", fixtureEntry, ...(options.args ?? [])],
    cwd: repoRoot,
    env: {
      ...process.env,
      SIXB_CLI_TEST_LOG: logPath,
      ...(options.drift ? { SIXB_CLI_TEST_LAKE_DRIFT: "1" } : {}),
      ...(options.noMaintenance ? { SIXB_CLI_TEST_LAKE_NO_MAINTENANCE: "1" } : {}),
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

describe("sixb lake check", () => {
  test("exits successfully when lake definitions are compatible", async () => {
    const result = await runLakeCommand("check")

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Lake definitions compatible")
    expect(result.stdout).toContain("cli-lake-project")
  })

  test("closes providers after a successful check", async () => {
    const result = await runLakeCommand("check")

    expect(result.exitCode).toBe(0)
    expect(result.logEntries).toContainEqual({ type: "lake-storage:close" })
  })

  test("fails when lake definitions drift", async () => {
    const result = await runLakeCommand("check", { drift: true })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Lake dataset definition check failed")
  })

  test("closes providers after a failed check", async () => {
    const result = await runLakeCommand("check", { drift: true })

    expect(result.exitCode).toBe(1)
    expect(result.logEntries).toContainEqual({ type: "lake-storage:close" })
  })
})

describe("sixb lake cleanup", () => {
  test("runs dry-run cleanup with default retention and prints the report", async () => {
    const result = await runLakeCommand("cleanup", { args: ["--dry-run"] })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Lake cleanup dry run complete")
    expect(result.stdout).toContain("cli-lake-project")
    expect(result.stdout).toContain("Snapshots")
    expect(result.stdout).toContain("2")
    expect(result.stdout).toContain("Old files")
    expect(result.stdout).toContain("3")
    expect(result.stdout).toContain("Orphaned files")
    expect(result.stdout).toContain("4")
    expect(result.logEntries).toContainEqual({
      type: "lake:maintenance",
      dryRun: true,
      expireOlderThan: "7 days",
      deleteOlderThan: "7 days",
    })
  })

  test("passes cleanup retention flags through", async () => {
    const result = await runLakeCommand("cleanup", {
      args: ["--expire-older-than", "1 hour", "--delete-older-than", "30 minutes"],
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Lake cleanup complete")
    expect(result.stdout).toContain("1 hour")
    expect(result.stdout).toContain("30 minutes")
    expect(result.stdout).not.toContain("DuckLake retention options persist")
    expect(result.logEntries).toContainEqual({
      type: "lake:maintenance",
      dryRun: false,
      expireOlderThan: "1 hour",
      deleteOlderThan: "30 minutes",
    })
  })

  test("defaults delete retention to expire retention", async () => {
    const result = await runLakeCommand("cleanup", {
      args: ["--dry-run", "--expire-older-than", "2 days"],
    })

    expect(result.exitCode).toBe(0)
    expect(result.logEntries).toContainEqual({
      type: "lake:maintenance",
      dryRun: true,
      expireOlderThan: "2 days",
      deleteOlderThan: "2 days",
    })
  })

  test("closes providers after successful cleanup", async () => {
    const result = await runLakeCommand("cleanup", { args: ["--dry-run"] })

    expect(result.exitCode).toBe(0)
    expect(result.logEntries).toContainEqual({ type: "lake-storage:close" })
  })

  test("fails clearly when lake storage does not support cleanup", async () => {
    const result = await runLakeCommand("cleanup", {
      noMaintenance: true,
      args: ["--dry-run"],
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Configured lake storage does not support maintenance cleanup")
    expect(result.logEntries).toContainEqual({ type: "lake-storage:close" })
  })
})
