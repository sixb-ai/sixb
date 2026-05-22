import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

function runCheckFixture(fixtureName: string): {
  exitCode: number
  stdout: string
  stderr: string
} {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..")
  const cliEntry = resolve(import.meta.dir, "..", "src", "index.tsx")
  const fixtureEntry = resolve(import.meta.dir, "fixtures", fixtureName, "pario.config.ts")

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

describe("pario check", () => {
  test("passes for a valid project", () => {
    const result = runCheckFixture("valid-project")

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Pario is healthy")
    expect(result.stdout).toContain("Project")
    expect(result.stdout).not.toContain("validation error(s)")
    expect(result.stderr).toBe("")
  })
})
