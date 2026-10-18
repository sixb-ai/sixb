import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runWorkerGroup } from "../src/commands/worker-group"
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
  const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-wg-"))
  tempDirs.push(tempDir)
  return join(tempDir, "operations.log")
}

// The long-running "starts workers" cases live in worker-group.e2e.ts.
describe("sixb worker-group", () => {
  // Rejected before the runtime loads: valid-project uses InMemoryQueues, so validating after
  // loading would end in that refusal and `process.exit(1)` instead of this error.
  test.each([
    ["an unknown worker type", { workerTypes: ["missing"] }, "Unknown worker 'missing'"],
    [
      "a group that still names the action worker",
      { workerTypes: ["sync", "action"] },
      "'action' is no longer a worker type",
    ],
    [
      "an invalid shared agent turn timeout",
      { workerTypes: ["agent"], agentTurnTimeout: "eventually" },
      "Invalid agent turn timeout 'eventually'",
    ],
    [
      "an invalid typed concurrency",
      { workerTypes: ["sync"], concurrency: ["sync=0"] },
      "Invalid worker concurrency '0'",
    ],
  ])("rejects %s before loading the runtime", async (_case, options, message) => {
    const result = await runInProcess(() => runWorkerGroup({ entry: validProject, ...options }))

    expect(result.exitCode).toBeUndefined()
    expect(String(result.error)).toContain(message)
  })

  test("rejects InMemoryQueues like sixb worker", async () => {
    const result = await runInProcess(() => runWorkerGroup({ entry: validProject }))

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("requires a queues provider")
    expect(result.output).toContain("InMemoryQueues")
  })

  test("refuses without migrating, so a bad command leaves no schema behind", async () => {
    // The fixture registers agents, so auto-selection picks the `agent` worker, whose construction
    // needs an API origin. The refusal is right; running a schema change first was not.
    const logPath = await tempLogPath()

    const result = await runInProcess(() => {
      process.env.SIXB_CLI_TEST_LOG = logPath
      delete process.env.SIXB_API_PUBLIC_ORIGIN
      return runWorkerGroup({ entry: fixtureEntry("worker-group") })
    })

    expect(result.exitCode).toBe(1)
    // One line: the panel wraps at the terminal width and draws a border.
    const output = result.output.replace(/[\u2500-\u257f\s]+/g, " ")
    expect(output).toContain("agent requires --api-public-origin")
    // Agent construction used to throw from inside the `map()` that builds every worker, so the
    // operator saw one line about agents and never learned sync, pipeline and projection were
    // never attempted. The three facts: what blocked, what it cost, and the way out — the last
    // as a remediation in its own section of the panel.
    expect(output).toContain("3 that were ready (sync, pipeline, projection)")
    expect(output).toContain("Try this")
    expect(output).toContain("sixb worker-group sync pipeline projection")
    const logEntries = await readLogEntries(logPath)
    expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
  })

  // The process boundary: the prod-roles fixture has no projection definitions, so the projection
  // worker throws on start; the group must still close providers and end the process non-zero.
  test("exits 1 and stops workers and providers when a worker fails to start", async () => {
    const logPath = await tempLogPath()
    const result = await runCliToCompletion({
      cmd: [
        "bun",
        resolve(import.meta.dir, "..", "src", "index.tsx"),
        "worker-group",
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
    const logEntries = await readLogEntries(logPath)
    expect(logEntries).toContainEqual({ type: "queues:close" })
    expect(logEntries).toContainEqual({ type: "lake-storage:close" })
  })
})
