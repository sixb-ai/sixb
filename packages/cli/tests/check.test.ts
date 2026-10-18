import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  type CompletedCliProcess,
  FAST_CLI_TIMEOUT_MS,
  runCliToCompletion,
} from "./shared/cli-process"

function runCheckFixture(fixtureName: string): Promise<CompletedCliProcess> {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", fixtureName, "sixb.config.ts")

  return runCliToCompletion({
    cmd: ["bun", cliEntry, "check", "--entry", fixtureEntry],
    cwd: repoRoot,
    timeoutMs: FAST_CLI_TIMEOUT_MS,
  })
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
  test("passes for a valid project", async () => {
    const result = await runCheckFixture("valid-project")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Sixb is healthy")
    expect(result.stdout).toContain("Project")
    expect(result.stdout).toMatch(/Markings\s+ok/)
    expect(result.stdout).not.toContain("validation error(s)")
    expect(result.stderr).toBe("")
  })

  test("reports an invalid Agent Skill before a deploy", async () => {
    // Skills used to be read only when the agent worker started, so `sixb check` passed.
    const result = await runCheckFixture("invalid-skill-project")

    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain("[Sixb] Agent Skill 'skills/acme-style'")
  })

  test("fails the command when a provider probe fails", async () => {
    // The old command exited 0 for everything but an empty ontology, because its four
    // provider rows were one hardcoded `{ ok: true }`. That made it useless as a deploy
    // gate: a missing database passed.
    const result = await runCheckFixture("unreachable-storage")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Sixb has issues")
    expect(result.stdout).toContain("UnreachableStorage")
  })

  // Reproduce: drop `markings` from the failed checks in commands/check.tsx; this exits 0.
  test("fails the command when a SQL step gives a projected column undeclared markings", async () => {
    const result = await runCheckFixture("misdeclared-markings-project")

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("Sixb has issues")
    expect(result.stdout).toContain("Markings")
    expect(result.stdout.replace(/\s+/g, " ")).toContain(
      "property 'Invoice.title' is projected from column 'invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/normalize-invoices'."
    )
  })

  test("exits instead of hanging when a provider holds the event loop open", async () => {
    // Without provider teardown, a ref'd handle (redis/pg connection, here a
    // setInterval) keeps the process alive forever after rendering. A timeout
    // here means that regressed.
    const result = await spawnCheckWithTimeout("lingering-handle-project", 15_000)

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
  }, 30_000)

  // Reproduce: remove the final `process.exit` from commands/check.tsx and this times out.
  test("exits when a provider keeps the process open after closing", async () => {
    const result = await spawnCheckWithTimeout("retrying-handle-project", 15_000)

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
  }, 30_000)
})
