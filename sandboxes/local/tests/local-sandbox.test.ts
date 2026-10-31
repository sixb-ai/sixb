import { describe, expect, test } from "bun:test"
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

  test("LocalSandbox.detectIsolation reports the host backend", () => {
    const probe = LocalSandbox.detectIsolation()
    expect(["seatbelt", "bwrap", "none"]).toContain(probe.backend)
  })
})
