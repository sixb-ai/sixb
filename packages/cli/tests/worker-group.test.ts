import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readLogEntries, startRoleUntilBannerThenStop } from "./shared/cli-process"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

function fixtureEntry(name: string): string {
  return resolve(import.meta.dir, "fixtures", name, "pario.config.ts")
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

async function tempLogPath(): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "pario-cli-wg-"))
  tempDirs.push(tempDir)
  return join(tempDir, "operations.log")
}

// Fail-fast cases exit on their own (guard rejection or worker start error), so a
// synchronous spawn is enough and lets us read the operations log afterward.
async function runOnce(
  args: readonly string[],
  fixture: string
): Promise<{ exitCode: number; stdout: string; logEntries: Array<Record<string, unknown>> }> {
  const logPath = await tempLogPath()

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, ...args, "--entry", fixtureEntry(fixture)],
    cwd: repoRoot,
    env: { ...process.env, PARIO_CLI_TEST_LOG: logPath },
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    logEntries: await readLogEntries(logPath),
  }
}

async function startThenStop(args: readonly string[], fixture: string) {
  const logPath = await tempLogPath()
  return startRoleUntilBannerThenStop({
    cmd: ["bun", cliEntry, ...args, "--entry", fixtureEntry(fixture)],
    cwd: repoRoot,
    logPath,
  })
}

describe("pario worker-group", () => {
  test("rejects unknown worker types", async () => {
    const result = await runOnce(["worker-group", "missing"], "valid-project")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Unknown worker 'missing'")
  })

  test("rejects InMemoryQueues like pario worker", async () => {
    const result = await runOnce(["worker-group"], "valid-project")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("requires a queue provider")
    expect(result.stdout).toContain("InMemoryQueues")
  })

  test("starts all registered worker types by default", async () => {
    const { bannerSeen, stdout, logEntries } = await startThenStop(["worker-group"], "worker-group")

    expect(bannerSeen).toBe(true)
    expect(stdout).toContain("worker group started")
    expect(stdout).toContain("sync")
    expect(stdout).toContain("pipeline")
    expect(stdout).toContain("projection")
    // Does not migrate storage at startup.
    expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
    // Clean shutdown stops queues and lake storage.
    expect(logEntries).toContainEqual({ type: "queues:close" })
    expect(logEntries).toContainEqual({ type: "lake-storage:close" })
  })

  test("starts only the selected worker types from positionals", async () => {
    const { bannerSeen, stdout, logEntries } = await startThenStop(
      ["worker-group", "sync"],
      "worker-group"
    )

    expect(bannerSeen).toBe(true)
    expect(stdout).toContain("worker group started")
    expect(stdout).toContain("sync")
    expect(stdout).not.toContain("pipeline")
    expect(stdout).not.toContain("projection")
    expect(logEntries).toContainEqual({ type: "queues:close" })
    expect(logEntries).toContainEqual({ type: "lake-storage:close" })
  })

  test("stops workers and providers when a worker fails to start", async () => {
    // The prod-roles fixture has no projection definitions, so the projection
    // worker throws on start; the group must still close providers and exit.
    const result = await runOnce(["worker-group", "projection"], "prod-roles")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("No projection definitions are registered")
    expect(result.logEntries).toContainEqual({ type: "queues:close" })
    expect(result.logEntries).toContainEqual({ type: "lake-storage:close" })
  })
})
