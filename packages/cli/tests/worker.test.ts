import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { resolveWorkerTypeToStart } from "../src/lib/worker-registry"

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
  const tempDir = await mkdtemp(join(tmpdir(), "sixb-cli-worker-"))
  tempDirs.push(tempDir)
  return join(tempDir, "operations.log")
}

async function readLogEntries(logPath: string): Promise<Array<Record<string, unknown>>> {
  const source = await readFile(logPath, "utf-8").catch(() => "")
  return source
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function runWorkerFixture(
  fixtureName: string,
  args: readonly string[] = [],
  options: { logPath?: string; env?: Record<string, string | undefined> } = {}
): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", fixtureName, "sixb.config.ts")

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "worker", "--entry", fixtureEntry, ...args],
    cwd: repoRoot,
    env: options.logPath
      ? {
          ...process.env,
          ...options.env,
          SIXB_CLI_TEST_LOG: options.logPath,
        }
      : { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
  }
}

function runHelp(): { exitCode: number; stdout: string; stderr: string } {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "help"],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf-8"),
    stderr: Buffer.from(result.stderr).toString("utf-8"),
  }
}

describe("sixb worker", () => {
  test("fails fast when the project uses InMemoryQueues", () => {
    const result = runWorkerFixture("valid-project", ["sync"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("requires a queues provider")
    expect(result.stdout).toContain("InMemoryQueues")
    expect(result.stderr).toBe("")
  })

  test("rejects unknown worker types before checking queue provider", () => {
    const result = runWorkerFixture("valid-project", ["missing"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Unknown worker 'missing'")
    expect(result.stdout).toContain("sync, action, agent")
    expect(result.stdout).toContain("pipeline, projection, workflow")
    expect(result.stdout).not.toContain("requires a queues provider")
    expect(result.stderr).toBe("")
  })

  test("accepts workflow as a known explicit worker type", () => {
    const result = runWorkerFixture("valid-project", ["workflow"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("requires a queues provider")
    expect(result.stdout).toContain("InMemoryQueues")
    expect(result.stdout).not.toContain("Unknown worker")
    expect(result.stderr).toBe("")
  })

  test("requires a positional worker type", () => {
    const result = runWorkerFixture("valid-project")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Usage: sixb worker")
    expect(result.stdout).toContain("<sync|action|agent|pipeline|projection|workflow>")
    expect(result.stderr).toBe("")
  })

  test("rejects removed worker selector flags", () => {
    const result = runWorkerFixture("valid-project", ["--type", "pipeline"])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Use `sixb worker <type>`")
    expect(result.stderr).toBe("")
  })

  test("validates the agent turn timeout before loading providers", () => {
    const result = runWorkerFixture("valid-project", [
      "agent",
      "--agent-turn-timeout",
      "eventually",
    ])

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Invalid agent turn timeout 'eventually'")
    expect(result.stdout).not.toContain("requires a queues provider")
    expect(result.stderr).toBe("")
  })

  test("refuses without migrating, so a bad command leaves no schema behind", async () => {
    // `sixb worker agent` cannot start without an API origin, and used to find that out after
    // bringing the schema up to date.
    const logPath = await tempLogPath()
    const result = runWorkerFixture("prod-roles", ["agent"], {
      logPath,
      env: { SIXB_API_PUBLIC_ORIGIN: undefined },
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("requires --api-public-origin")

    const logEntries = await readLogEntries(logPath)
    expect(logEntries.some((entry) => entry.type === "storage:migrate")).toBe(false)
  })

  test("closes runtime providers when startup fails after loading the runtime", async () => {
    const logPath = await tempLogPath()
    const result = runWorkerFixture("prod-roles", ["projection"], { logPath })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("No projection definitions are registered")
    expect(result.stderr).toBe("")

    const logEntries = await readLogEntries(logPath)
    expect(logEntries).toContainEqual({ type: "queues:close" })
    expect(logEntries).toContainEqual({ type: "lake-storage:close" })
  })

  test("is listed in the CLI help", () => {
    const result = runHelp()

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("worker <type>")
    expect(result.stdout).not.toContain("--type <type>")
    expect(result.stdout).not.toContain("--worker <type>")
    expect(result.stdout).toContain("sync, action, agent")
    expect(result.stdout).toContain("pipeline, projection, workflow")
    expect(result.stdout).toContain("--agent-turn-timeout <duration>")
    expect(result.stderr).toBe("")
  })

  test("resolves the requested worker type directly", () => {
    expect(resolveWorkerTypeToStart("pipeline")).toBe("pipeline")
    expect(resolveWorkerTypeToStart("workflow")).toBe("workflow")
  })

  test("rejects unknown workers with the known worker list", () => {
    expect(() => resolveWorkerTypeToStart("missing")).toThrow(
      "Available: sync, action, agent, pipeline, projection, workflow"
    )
  })
})
