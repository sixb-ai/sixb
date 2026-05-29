import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startRoleUntilBannerThenStop } from "./shared/cli-process"

// These boot worker processes and wait for them to start, so they live as e2e
// tests: `bun test` skips `*.e2e.ts`, keeping them out of the heavily parallel
// unit run where subprocess cold-starts get starved.

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

function fixtureEntry(name: string): string {
  return resolve(import.meta.dir, "fixtures", name, "pario.config.ts")
}

const WORKER_GROUP_TIMEOUT_MS = 30_000

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
  const tempDir = await mkdtemp(join(tmpdir(), "pario-cli-wg-"))
  const logPath = join(tempDir, "operations.log")
  tempDirs.push(tempDir)

  return startRoleUntilBannerThenStop({
    cmd: ["bun", cliEntry, ...args, "--entry", fixtureEntry(fixture)],
    cwd: repoRoot,
    logPath,
  })
}

describe("pario worker-group (e2e)", () => {
  test(
    "starts all registered worker types by default",
    async () => {
      const { bannerSeen, stdout, logEntries } = await startThenStop(
        ["worker-group"],
        "worker-group"
      )

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
    },
    WORKER_GROUP_TIMEOUT_MS
  )

  test(
    "starts only the selected worker types from positionals",
    async () => {
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
    },
    WORKER_GROUP_TIMEOUT_MS
  )
})
