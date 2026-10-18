import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { runCheck } from "../src/commands/check"
import { runCliToCompletion } from "./shared/cli-process"
import { runInProcess } from "./shared/in-process"

function fixtureEntry(name: string): string {
  return resolve(import.meta.dir, "fixtures", name, "sixb.config.ts")
}

function check(fixture: string) {
  return runInProcess(() => runCheck({ entry: fixtureEntry(fixture) }))
}

describe("sixb check", () => {
  test("passes for a valid project", async () => {
    const result = await check("valid-project")

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("Sixb is healthy")
    expect(result.output).toContain("Project")
    expect(result.output).toMatch(/Markings\s+ok/)
    expect(result.output).not.toContain("validation error(s)")
    expect(result.stderr).toBe("")
  })

  test("reports an invalid Agent Skill before a deploy", async () => {
    // Skills used to be read only when the agent worker started, so `sixb check` passed.
    const result = await check("invalid-skill-project")

    expect(String(result.error)).toContain("[Sixb] Agent Skill 'skills/acme-style'")
  })

  test("fails the command when a provider probe fails", async () => {
    // The old command exited 0 for everything but an empty ontology, because its four
    // provider rows were one hardcoded `{ ok: true }`. That made it useless as a deploy
    // gate: a missing database passed.
    const result = await check("unreachable-storage")

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Sixb has issues")
    expect(result.output).toContain("UnreachableStorage")
  })

  // Reproduce: drop `markings` from the failed checks in commands/check.tsx; this exits 0.
  test("fails the command when a SQL step gives a projected column undeclared markings", async () => {
    const result = await check("misdeclared-markings-project")

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("Sixb has issues")
    expect(result.output).toContain("Markings")
    expect(result.output.replace(/[\s│]+/g, " ")).toContain(
      "property 'Invoice.title' is projected from column 'invoices.title', which carries [financial] from 'raw_invoices.amount' through step 'invoices/normalize-invoices'."
    )
  })

  // The process boundary: a deploy gated on `sixb check` needs the process to end. This fixture's
  // client keeps a handle open after it reports itself closed, so only the command's final
  // `process.exit` ends it. Reproduce: remove that `process.exit` from commands/check.tsx and
  // this times out.
  test("exits when a provider keeps the process open after closing", async () => {
    const result = await runCliToCompletion({
      cmd: [
        "bun",
        resolve(import.meta.dir, "..", "src", "index.tsx"),
        "check",
        "--entry",
        fixtureEntry("retrying-handle-project"),
      ],
      cwd: resolve(import.meta.dir, "..", "..", ".."),
      timeoutMs: 10_000,
    })

    expect(result.exitCode).toBe(0)
  }, 15_000)
})
