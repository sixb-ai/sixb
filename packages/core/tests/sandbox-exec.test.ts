import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exec } from "../src/sandboxes/exec"

describe("exec", () => {
  const directories: string[] = []

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "sixb-exec-"))
    directories.push(directory)
    return directory
  }

  // Guard proof: drop the working-directory check in exec's spawn failure; the error names
  // '/bin/sh' (on macOS, `sandbox-exec` for every isolated command) instead of the directory.
  test("a missing working directory is named, not the program", async () => {
    const cwd = join(temporaryDirectory(), "workspace")

    const result = await exec({ argv: ["/bin/sh", "-c", "echo ok"], cwd, env: {} })

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: "",
      stderr: `[Sandbox] working directory '${cwd}' does not exist or is not a directory`,
    })
  })

  test("a working directory that is a file is named, not the program", async () => {
    const cwd = join(temporaryDirectory(), "notes.txt")
    writeFileSync(cwd, "notes")

    const result = await exec({ argv: ["/bin/sh", "-c", "echo ok"], cwd, env: {} })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(`'${cwd}'`)
  })

  test("a missing program in an existing directory still reports the spawn error", async () => {
    const result = await exec({
      argv: ["sixb-no-such-program"],
      cwd: temporaryDirectory(),
      env: {},
    })

    expect(result.exitCode).toBe(127)
    expect(result.stderr).toContain("sixb-no-such-program")
  })
})
