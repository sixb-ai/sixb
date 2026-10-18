import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { readLogEntries, startRoleUntilReadyThenStop } from "./shared/cli-process"

// These boot worker processes and wait for them to start, so they live as e2e
// tests: `bun test` skips `*.e2e.ts`, keeping them out of the heavily parallel
// unit run where subprocess cold-starts get starved.

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

function fixtureEntry(name: string): string {
  return resolve(import.meta.dir, "fixtures", name, "sixb.config.ts")
}

const WORKER_GROUP_TIMEOUT_MS = 30_000
const CLAIM_TIMEOUT_MS = 10_000

/**
 * Starts the group, waits until each expected worker type has claimed from its queue, then stops
 * it. A worker claims as it starts, before the group reports ready, so the set of types that
 * claimed is final by then: a type missing from it was never started.
 */
async function startThenStop(
  args: readonly string[],
  fixture: string,
  expectedClaims: readonly string[]
) {
  const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-wg-"))
  const logPath = join(tempDir, "operations.log")

  try {
    return await startRoleUntilReadyThenStop({
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
      whileReady: () => untilClaimed(logPath, expectedClaims),
    })
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function untilClaimed(logPath: string, workerTypes: readonly string[]): Promise<void> {
  const deadline = Date.now() + CLAIM_TIMEOUT_MS
  for (;;) {
    const claimed = claimedWorkerTypes(await readLogEntries(logPath))
    const missing = workerTypes.filter((workerType) => !claimed.has(workerType))
    if (missing.length === 0) return
    if (Date.now() > deadline) {
      throw new Error(`[Test] No claim from ${missing.join(", ")} within ${CLAIM_TIMEOUT_MS}ms.`)
    }
    await Bun.sleep(20)
  }
}

function claimedWorkerTypes(logEntries: Array<Record<string, unknown>>): Set<string> {
  return new Set(
    logEntries.filter((entry) => entry.type === "claim").map((entry) => entry.workerType as string)
  )
}

// Each test runs its own process with its own log, so they run together.
describe("sixb worker-group (e2e)", () => {
  test.concurrent(
    "starts all registered worker types by default",
    async () => {
      const { ready, logEntries } = await startThenStop(["worker-group"], "worker-group", [
        "sync",
        "pipeline",
        "projection",
        "agent",
      ])

      expect(ready).toBe(true)
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

  test.concurrent(
    "starts only the selected worker types, each with its own concurrency limit",
    async () => {
      const { ready, logEntries } = await startThenStop(
        ["worker-group", "sync", "agent", "--concurrency", "sync=2", "--concurrency", "agent=6"],
        "worker-group",
        ["sync", "agent"]
      )

      expect(ready).toBe(true)
      expect(logEntries).toContainEqual({ type: "claim", workerType: "sync", limit: 2 })
      expect(logEntries).toContainEqual({ type: "claim", workerType: "agent", limit: 6 })
      // Registered, but not named on the command line.
      const claimed = claimedWorkerTypes(logEntries)
      expect(claimed.has("pipeline")).toBe(false)
      expect(claimed.has("projection")).toBe(false)
      expect(logEntries).toContainEqual({ type: "queues:close" })
      expect(logEntries).toContainEqual({ type: "lake-storage:close" })
    },
    WORKER_GROUP_TIMEOUT_MS
  )
})
