import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

function runCheckFixture(fixtureName: string): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", fixtureName, "sixb.config.ts")

  const result = Bun.spawnSync({
    cmd: ["bun", cliEntry, "check", "--entry", fixtureEntry],
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

async function spawnCheckWithTimeout(
  fixtureName: string,
  timeoutMs: number
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", fixtureName, "sixb.config.ts")

  const proc = Bun.spawn({
    cmd: ["bun", cliEntry, "check", "--entry", fixtureEntry],
    cwd: repoRoot,
    stdout: "ignore",
    stderr: "ignore",
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, timeoutMs)

  const exitCode = await proc.exited
  clearTimeout(timer)

  return { exitCode, timedOut }
}

describe("sixb check", () => {
  test("passes for a valid project", () => {
    const result = runCheckFixture("valid-project")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Sixb is healthy")
    expect(result.stdout).toContain("Project")
    expect(result.stdout).not.toContain("validation error(s)")
    expect(result.stderr).toBe("")
  })

  test("fails the command when a provider probe fails", () => {
    // The old command exited 0 for everything but an empty ontology, because its four
    // provider rows were one hardcoded `{ ok: true }`. That made it useless as a deploy
    // gate: a missing database passed.
    const result = runCheckFixture("unreachable-storage")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Sixb has issues")
    expect(result.stdout).toContain("UnreachableStorage")
  })

  test("exits instead of hanging when a provider holds the event loop open", async () => {
    // Without provider teardown, a ref'd handle (redis/pg connection, here a
    // setInterval) keeps the process alive forever after rendering. A timeout
    // here means that regressed.
    const result = await spawnCheckWithTimeout("lingering-handle-project", 15_000)

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
  }, 30_000)
})
