import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startRoleUntilReadyThenStop } from "./shared/cli-process"

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
      // Does not migrate storage at startup.
      expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
      // Clean shutdown stops queues and lake storage.
      expect(logEntries).toContainEqual({ type: "queues:close" })
      expect(logEntries).toContainEqual({ type: "lake-storage:close" })
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
})
