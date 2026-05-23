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
  subcommand: "check",
  options: { drift?: boolean } = {}
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
    cmd: ["bun", cliEntry, "lake", subcommand, "--entry", fixtureEntry],
    cwd: repoRoot,
    env: {
      ...process.env,
      SIXB_CLI_TEST_LOG: logPath,
      ...(options.drift ? { SIXB_CLI_TEST_LAKE_DRIFT: "1" } : {}),
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
