import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readLogEntries } from "./shared/cli-process"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

function fixtureEntry(name: string): string {
  return resolve(import.meta.dir, "fixtures", name, "sixb.config.ts")
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
  const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-wg-"))
  tempDirs.push(tempDir)
  return join(tempDir, "operations.log")
}

// Fail-fast cases exit on their own (guard rejection or worker start error), so a
// synchronous spawn is enough and lets us read the operations log afterward. The
// long-running "starts workers" cases live in worker-group.e2e.ts.
async function runOnce(
  args: readonly string[],
  fixture: string
): Promise<{ exitCode: number; stdout: string; logEntries: Array<Record<string, unknown>> }> {
  const logPath = await tempLogPath()

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, ...args, "--entry", fixtureEntry(fixture)],
    cwd: repoRoot,
    env: { ...process.env, SIXB_CLI_TEST_LOG: logPath },
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    logEntries: await readLogEntries(logPath),
  }
}

describe("sixb worker-group", () => {
  test("rejects unknown worker types", async () => {
    const result = await runOnce(["worker-group", "missing"], "valid-project")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Unknown worker 'missing'")
  })

  test("rejects InMemoryQueues like sixb worker", async () => {
    const result = await runOnce(["worker-group"], "valid-project")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("requires a queue provider")
    expect(result.stdout).toContain("InMemoryQueues")
  })

  test("stops workers and providers when a worker fails to start", async () => {
    // The fixture registers a sync but omits storage.syncRuns, so the sync
    // worker throws on start; the group must still close providers and exit.
    const result = await runOnce(["worker-group", "sync"], "worker-missing-run-storage")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("storage.syncRuns")
    expect(result.logEntries).toContainEqual({ type: "queues:close" })
    expect(result.logEntries).toContainEqual({ type: "lake-storage:close" })
  })
})
