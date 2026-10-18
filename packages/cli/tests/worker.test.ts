import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runWorker } from "../src/commands/worker"
import { FAST_CLI_TIMEOUT_MS, readLogEntries, runCliToCompletion } from "./shared/cli-process"
import { runInProcess } from "./shared/in-process"

const validProject = fixtureEntry("valid-project")
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function fixtureEntry(name: string): string {
  return resolve(import.meta.dir, "fixtures", name, "sixb.config.ts")
}

async function tempLogPath(): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-worker-"))
  tempDirs.push(tempDir)
  return join(tempDir, "operations.log")
}

describe("sixb worker", () => {
  // Rejected before the runtime loads: valid-project uses InMemoryQueues, so validating after
  // loading would end in that refusal and `process.exit(1)` instead of this error.
  test.each([
    [
      "an unknown worker type",
      { workerType: "missing" },
      "Unknown worker 'missing'. Available: sync, agent, pipeline, projection, workflow",
    ],
    [
      "the action worker",
      { workerType: "action" },
      "[SixbWorker] 'action' is no longer a worker type: Actions run in the process that " +
        "requests them (API, workflows, syncs). Remove it from the command.",
    ],
    [
      "an invalid agent turn timeout",
      { workerType: "agent", agentTurnTimeout: "eventually" },
      "Invalid agent turn timeout 'eventually'",
    ],
    [
      "an invalid concurrency",
      { workerType: "sync", concurrency: "0" },
      "Invalid worker concurrency '0'",
    ],
  ])("rejects %s before loading the runtime", async (_case, options, message) => {
    const result = await runInProcess(() => runWorker({ entry: validProject, ...options }))

    expect(result.exitCode).toBeUndefined()
    expect(String(result.error)).toContain(message)
  })

  test("refuses InMemoryQueues for a known worker type", async () => {
    const result = await runInProcess(() =>
      runWorker({ entry: validProject, workerType: "workflow" })
    )

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("requires a queues provider")
    expect(result.output).toContain("InMemoryQueues")
  })

  test("refuses without migrating, so a bad command leaves no schema behind", async () => {
    // A project with agent work requires an API origin before migrating. Accounting-only
    // workers can start without one.
    const logPath = await tempLogPath()

    const result = await runInProcess(() => {
      process.env.SIXB_CLI_TEST_LOG = logPath
      delete process.env.SIXB_API_PUBLIC_ORIGIN
      return runWorker({ entry: fixtureEntry("worker-group"), workerType: "agent" })
    })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("requires --api-public-origin")
    const logEntries = await readLogEntries(logPath)
    expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
  })

  // The process boundary: a startup failure has to end the process with a non-zero code after
  // closing what it opened, not leave it running.
  test("exits 1 and closes runtime providers when startup fails after loading the runtime", async () => {
    const logPath = await tempLogPath()
    const result = await runCliToCompletion({
      cmd: [
        "bun",
        resolve(import.meta.dir, "..", "src", "index.tsx"),
        "worker",
        "projection",
        "--entry",
        fixtureEntry("prod-roles"),
      ],
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      env: { SIXB_CLI_TEST_LOG: logPath },
      timeoutMs: FAST_CLI_TIMEOUT_MS,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("No projection definitions are registered")
    expect(result.stderr).toBe("")
    const logEntries = await readLogEntries(logPath)
    expect(logEntries).toContainEqual({ type: "queues:close" })
    expect(logEntries).toContainEqual({ type: "lake-storage:close" })
  })
})
