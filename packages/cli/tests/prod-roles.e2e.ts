import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startRoleUntilReadyThenStop } from "./shared/cli-process"

// These boot a full production role (a long-running bun runtime) and wait for it
// to start, so they live as e2e tests: `bun test` skips `*.e2e.ts`, keeping them
// out of the heavily parallel unit run where subprocess cold-starts get starved.

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const fixtureEntry = resolve(import.meta.dir, "fixtures", "prod-roles", "pario.config.ts")

const ROLE_TIMEOUT_MS = 30_000

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

async function startRole(args: readonly string[]) {
  const tempDir = await mkdtemp(join(tmpdir(), "pario-cli-roles-"))
  const logPath = join(tempDir, "operations.log")
  tempDirs.push(tempDir)

  return startRoleUntilReadyThenStop({
    cmd: ["bun", cliEntry, ...args, "--entry", fixtureEntry],
    cwd: repoRoot,
    logPath,
  })
}

const backgroundRoles: Array<{
  name: string
  command: readonly string[]
  expectProviderClose?: boolean
}> = [
  { name: "orchestrator", command: ["orchestrator"] },
  { name: "scheduler", command: ["scheduler"] },
  { name: "functions", command: ["functions"] },
  { name: "rules", command: ["rules"] },
  { name: "worker sync", command: ["worker", "sync"], expectProviderClose: true },
]

describe("role startup connection budget", () => {
  for (const role of backgroundRoles) {
    test(
      `pario ${role.name} starts without migrating storage or touching lake storage`,
      async () => {
        const { ready, logEntries } = await startRole(role.command)

        expect(ready).toBe(true)
        // Production roles do not stampede storage migrations at startup; that is a
        // dedicated `pario db migrate` release step.
        expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
        // Roles do not open the lake catalog at startup either.
        expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)
        if (role.expectProviderClose) {
          expect(logEntries).toContainEqual({ type: "queues:close" })
          expect(logEntries).toContainEqual({ type: "lake-storage:close" })
        }
      },
      ROLE_TIMEOUT_MS
    )
  }

  test(
    "pario api starts without migrating storage or touching lake storage",
    async () => {
      const { ready, logEntries } = await startRole([
        "api",
        "--port",
        "47821",
        "--api-port",
        "47822",
        "--api-public-origin",
        "http://localhost:47822",
        "--atlas-public-origin",
        "http://localhost:47821",
        "--sentinel-public-origin",
        "http://localhost:47823",
      ])

      expect(ready).toBe(true)
      expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
      expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)
    },
    ROLE_TIMEOUT_MS
  )
})
