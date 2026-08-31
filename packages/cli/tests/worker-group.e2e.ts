import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runCliToCompletion, startRoleUntilReadyThenStop } from "./shared/cli-process"

// These boot worker processes and wait for them to start, so they live as e2e
// tests: `bun test` skips `*.e2e.ts`, keeping them out of the heavily parallel
// unit run where subprocess cold-starts get starved.

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

function fixtureEntry(name: string): string {
  return resolve(import.meta.dir, "fixtures", name, "sixb.config.ts")
}

const WORKER_GROUP_TIMEOUT_MS = 30_000
// Give the started worker poll loops time to claim their queues at least once.
const CLAIM_GRACE_MS = 1_500

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

async function startThenStop(args: readonly string[], fixture: string) {
  const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-wg-"))
  const logPath = join(tempDir, "operations.log")
  tempDirs.push(tempDir)

  return startRoleUntilReadyThenStop({
    cmd: [
      "bun",
      cliEntry,
      ...args,
      "--entry",
      fixtureEntry(fixture),
      "--api-public-origin",
      "http://localhost:3002",
    ],
    cwd: repoRoot,
    logPath,
    graceMs: CLAIM_GRACE_MS,
  })
}

/**
 * Ink wraps a failure in a bordered box, so the message arrives split across lines by
 * `│` and padding. Asserting on a phrase requires putting it back together first.
 */
function flattenTerminalOutput(output: string): string {
  return output
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u2500-\u257f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function claimedWorkerTypes(logEntries: Array<Record<string, unknown>>): Set<string> {
  return new Set(
    logEntries.filter((entry) => entry.type === "claim").map((entry) => entry.workerType as string)
  )
}

describe("sixb worker-group (e2e)", () => {
  test(
    "starts all registered worker types by default",
    async () => {
      const { ready, logEntries } = await startThenStop(["worker-group"], "worker-group")

      expect(ready).toBe(true)
      const claimed = claimedWorkerTypes(logEntries)
      expect(claimed.has("sync")).toBe(true)
      expect(claimed.has("pipeline")).toBe(true)
      expect(claimed.has("projection")).toBe(true)
      expect(claimed.has("agent")).toBe(true)
      // Brings the storage schema up to date at startup, like every other role that reads
      // or writes through it. Co-hosting workers in one process does not change that.
      expect(logEntries).toContainEqual({ type: "storage:migrate" })
      // Same startup budget the single-purpose roles are held to: co-hosting several
      // workers in one process must not make that process attach the lake catalog at boot,
      // which is what made starting every role at once stampede a shared DuckLake.
      expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)
      // Clean shutdown stops queues and lake storage.
      expect(logEntries).toContainEqual({ type: "queues:close" })
      expect(logEntries).toContainEqual({ type: "lake-storage:close" })
    },
    WORKER_GROUP_TIMEOUT_MS
  )

  test(
    "refuses the whole group and says which workers it took down",
    async () => {
      // The fixture registers agents, so auto-discovery selects the `agent` worker. Its
      // construction needs an API origin, and it used to throw from inside the `map()`
      // that builds every worker — so the operator saw one line about agents and had no
      // way to know that sync, pipeline and projection had never been attempted.
      const result = await runCliToCompletion({
        cmd: ["bun", cliEntry, "worker-group", "--entry", fixtureEntry("worker-group")],
        cwd: repoRoot,
        env: { SIXB_API_PUBLIC_ORIGIN: undefined },
        timeoutMs: WORKER_GROUP_TIMEOUT_MS,
      })

      expect(result.exitCode).toBe(1)
      const output = flattenTerminalOutput(`${result.stdout}${result.stderr}`)
      expect(output).toContain("agent requires --api-public-origin")
      // The three facts an operator needs: what blocked, what it cost, and the way out.
      expect(output).toContain("3 that were ready (sync, pipeline, projection)")
      // The way out arrives as a remediation, rendered in its own section rather than
      // appended to the diagnosis — this is what proves it survives the terminal path.
      expect(output).toContain("Try this")
      expect(output).toContain("sixb worker-group sync pipeline projection")
    },
    WORKER_GROUP_TIMEOUT_MS
  )

  test(
    "starts only the selected worker types from positionals",
    async () => {
      const { ready, logEntries } = await startThenStop(["worker-group", "sync"], "worker-group")

      expect(ready).toBe(true)
      const claimed = claimedWorkerTypes(logEntries)
      expect(claimed.has("sync")).toBe(true)
      expect(claimed.has("pipeline")).toBe(false)
      expect(claimed.has("projection")).toBe(false)
      expect(claimed.has("agent")).toBe(false)
      expect(logEntries).toContainEqual({ type: "queues:close" })
      expect(logEntries).toContainEqual({ type: "lake-storage:close" })
    },
    WORKER_GROUP_TIMEOUT_MS
  )

  test(
    "applies an independent concurrency limit to each selected worker",
    async () => {
      const { ready, logEntries } = await startThenStop(
        ["worker-group", "sync", "agent", "--concurrency", "sync=2", "--concurrency", "agent=6"],
        "worker-group"
      )

      expect(ready).toBe(true)
      expect(logEntries).toContainEqual({ type: "claim", workerType: "sync", limit: 2 })
      expect(logEntries).toContainEqual({ type: "claim", workerType: "agent", limit: 6 })
    },
    WORKER_GROUP_TIMEOUT_MS
  )
})
