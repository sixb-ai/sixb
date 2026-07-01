import { describe, expect, test } from "bun:test"
import { runSandboxesContractSuite } from "@sixb/core/testing"
import { LocalSandbox } from "../src/local-sandbox"
import { LocalSandboxFactory } from "../src/local-sandbox-factory"

runSandboxesContractSuite("LocalSandbox (none)", {
  createFactory: () => new LocalSandboxFactory({ isolation: "none" }),
  capabilities: {
    networkBlocking: false,
    restrictedEgressEnforcement: false,
    readOnlyEnforcement: false,
    isolation: false,
  },
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

  test("LocalSandbox.detectIsolation reports the host backend", () => {
    const probe = LocalSandbox.detectIsolation()
    expect(["seatbelt", "bwrap", "none"]).toContain(probe.backend)
  })
})
