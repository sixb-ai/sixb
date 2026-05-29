import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { startRoleUntilBannerThenStop } from "./shared/cli-process"

const repoRoot = resolve(import.meta.dir, "..", "..", "..")
const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
const fixtureEntry = resolve(import.meta.dir, "fixtures", "prod-roles", "pario.config.ts")

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

  return startRoleUntilBannerThenStop({
    cmd: ["bun", cliEntry, ...args, "--entry", fixtureEntry],
    cwd: repoRoot,
    logPath,
  })
}

const backgroundRoles: Array<{ name: string; command: readonly string[] }> = [
  { name: "orchestrator", command: ["orchestrator"] },
  { name: "scheduler", command: ["scheduler"] },
  { name: "functions", command: ["functions"] },
  { name: "rules", command: ["rules"] },
  { name: "worker sync", command: ["worker", "sync"] },
]

describe("role startup connection budget", () => {
  for (const role of backgroundRoles) {
    test(`pario ${role.name} starts without migrating storage or touching lake storage`, async () => {
      const { bannerSeen, logEntries } = await startRole(role.command)

      expect(bannerSeen).toBe(true)
      // Production roles do not stampede storage migrations at startup; that is a
      // dedicated `pario db migrate` release step.
      expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
      // Roles do not open the lake catalog at startup either.
      expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)
    })
  }

  test("pario api starts without migrating storage or touching lake storage", async () => {
    const { bannerSeen, logEntries } = await startRole([
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

    expect(bannerSeen).toBe(true)
    expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
    expect(logEntries.some((entry) => entry.type === "lake:assert")).toBe(false)
  })
})
