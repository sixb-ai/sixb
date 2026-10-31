import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runSandboxesContractSuite } from "@sixb/core/testing"
import { LocalSandbox } from "../src/local-sandbox"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

runSandboxesContractSuite("LocalSandbox (none)", {
  createFactory: () => new LocalSandboxFactory({ isolation: "none" }),
  capabilities: {
    networkBlocking: false,
    readOnlyEnforcement: false,
    isolation: false,
  },
  // The timer starts after the spawn, so any bound below `sleep`'s runtime proves the kill.
  shortTimeoutMs: 50,
})

describe("LocalSandbox shell-injection regression", () => {
  test("args containing shell metacharacters are passed verbatim", async () => {
    const factory = new LocalSandboxFactory({ isolation: "none" })
    const sandbox = await factory.create()
    try {
      const result = await sandbox.runCommand("echo", ["a; rm -rf /"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("a; rm -rf /")
    } finally {
      await sandbox.destroy()
    }
  })

  // Guard proof: drop the devices' allow rule from buildSeatbeltProfile; on macOS this fails.
  test("a command can discard its output to /dev/null", async () => {
    const sandbox = await new LocalSandboxFactory().create()
    try {
      const result = await sandbox.runCommand("/bin/sh", [
        "-c",
        "echo noise 2>/dev/null >/dev/null && echo ok",
      ])
      expect(result).toMatchObject({ exitCode: 0, stdout: "ok\n" })
    } finally {
      await sandbox.destroy()
    }
  })

  // Guard proof: confine writeFiles to the working directory again; the run file is refused.
  test("writes files where its commands may write, and nowhere else", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "sixb-local-rw-")))
    const runFiles = join(elsewhere, "run")
    const sandbox = await new LocalSandboxFactory({ readWritePaths: [runFiles] }).create()
    try {
      await sandbox.writeFiles([{ path: join(runFiles, "skills", "a.md"), contents: "# a" }])
      expect(readFileSync(join(runFiles, "skills", "a.md"), "utf8")).toBe("# a")
      expect(
        await sandbox
          .writeFiles([{ path: join(elsewhere, "other.md"), contents: "no" }])
          .catch((error: unknown) => error)
      ).toBeInstanceOf(Error)
      expect(existsSync(join(elsewhere, "other.md"))).toBe(false)
    } finally {
      await sandbox.destroy()
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  // Guard proof: write through mkdir/writeFile without assertReallyWritable and O_NOFOLLOW; both
  // writes land outside, in the directory the links lead to.
  test("writes no file through a link a command made, though it lies where commands may write", async () => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "sixb-local-links-")))
    const runFiles = join(elsewhere, "run")
    const outside = join(elsewhere, "outside")
    mkdirSync(runFiles)
    mkdirSync(outside)
    const sandbox = await new LocalSandboxFactory({ readWritePaths: [runFiles] }).create()
    try {
      await sandbox.runCommand("/bin/sh", [
        "-c",
        `ln -s ${outside} ${join(runFiles, "dir")} && ln -s ${join(outside, "f")} ${join(runFiles, "f")}`,
      ])
      for (const path of [join(runFiles, "dir", "x.txt"), join(runFiles, "f")]) {
        expect(
          await sandbox.writeFiles([{ path, contents: "no" }]).catch((error: unknown) => error),
          path
        ).toBeInstanceOf(Error)
      }
      expect(readdirSync(outside)).toEqual([])
    } finally {
      await sandbox.destroy()
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test("LocalSandbox.detectIsolation reports the host backend", () => {
    const probe = LocalSandbox.detectIsolation()
    expect(["seatbelt", "bwrap", "none"]).toContain(probe.backend)
  })
})
