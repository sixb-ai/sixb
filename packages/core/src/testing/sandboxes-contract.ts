import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { type SandboxFactory, SandboxNotRunningError } from "../sandboxes"

/**
 * Capability flags letting a provider declare which contract slices are
 * meaningful for it. Tests gated by an unsupported capability are skipped.
 */
export interface SandboxesContractCapabilities {
  /** network.mode="none" actually blocks outbound network access. */
  readonly networkBlocking?: boolean
  /** readOnlyPaths/readWritePaths actually restrict filesystem writes. */
  readonly readOnlyEnforcement?: boolean
  /** Strong isolation, such as process namespaces, is in effect. */
  readonly isolation?: boolean
}

export interface SandboxesContractSuiteOptions {
  /** Factory under test. Called once per describe block. */
  readonly createFactory: () => SandboxFactory | Promise<SandboxFactory>
  /** Optional cleanup invoked once per test after factory-created sandboxes are destroyed. */
  readonly teardown?: (factory: SandboxFactory) => void | Promise<void>
  readonly capabilities?: SandboxesContractCapabilities
  /**
   * Timeout in milliseconds used by the timeout/abort tests. Bump on slow CI.
   * Default 200ms.
   */
  readonly shortTimeoutMs?: number
}

const SLEEP_BUDGET_SECONDS = 5

/**
 * Provider-independent contract for Sandbox and SandboxFactory. Concrete
 * providers wire this into their tests via runSandboxesContractSuite(...).
 */
export function runSandboxesContractSuite(
  label: string,
  options: SandboxesContractSuiteOptions
): void {
  const shortTimeoutMs = options.shortTimeoutMs ?? 200
  const capabilities = options.capabilities ?? {}

  describe(label, () => {
    let factory: SandboxFactory

    beforeEach(async () => {
      factory = await options.createFactory()
    })

    afterEach(async () => {
      await options.teardown?.(factory)
    })

    describe("lifecycle", () => {
      test("create returns a running sandbox with a non-empty id", async () => {
        const sandbox = await factory.create()
        try {
          expect(sandbox.status).toBe("running")
          expect(sandbox.id.length).toBeGreaterThan(0)
          expect(sandbox.workingDirectory.length).toBeGreaterThan(0)
        } finally {
          await sandbox.destroy()
        }
      })

      test("runCommand returns exit code 0 and captured stdout for echo", async () => {
        const sandbox = await factory.create()
        try {
          const result = await sandbox.runCommand("echo", ["hello"])
          expect(result.exitCode).toBe(0)
          expect(result.stdout.trim()).toBe("hello")
          expect(result.stderr).toBe("")
          expect(result.durationMs).toBeGreaterThanOrEqual(0)
          expect(result.timedOut).not.toBe(true)
        } finally {
          await sandbox.destroy()
        }
      })

      test("nonexistent binary resolves with non-zero exit code", async () => {
        const sandbox = await factory.create()
        try {
          const result = await sandbox.runCommand("does-not-exist-xyz-sixb-test", [])
          expect(result.exitCode).not.toBe(0)
        } finally {
          await sandbox.destroy()
        }
      })

      test("captures stdout and stderr as separate streams", async () => {
        const sandbox = await factory.create()
        try {
          const result = await sandbox.runCommand("/bin/sh", [
            "-c",
            "echo out-line; echo err-line >&2; exit 0",
          ])
          expect(result.exitCode).toBe(0)
          expect(result.stdout).toContain("out-line")
          expect(result.stderr).toContain("err-line")
          expect(result.stdout).not.toContain("err-line")
          expect(result.stderr).not.toContain("out-line")
        } finally {
          await sandbox.destroy()
        }
      })

      test("stop transitions status and rejects subsequent runCommand", async () => {
        const sandbox = await factory.create()
        try {
          await sandbox.stop()
          expect(sandbox.status).toBe("stopped")
          await expect(sandbox.runCommand("echo", ["nope"])).rejects.toBeInstanceOf(
            SandboxNotRunningError
          )
        } finally {
          await sandbox.destroy()
        }
      })

      test("destroy is idempotent", async () => {
        const sandbox = await factory.create()
        await sandbox.destroy()
        await sandbox.destroy()
        await expect(sandbox.runCommand("echo", ["x"])).rejects.toBeInstanceOf(
          SandboxNotRunningError
        )
      })
    })

    describe("working directory", () => {
      test("pwd reflects the configured workingDirectory", async () => {
        const sandbox = await factory.create()
        try {
          const result = await sandbox.runCommand("pwd")
          const expected = await realpath(sandbox.workingDirectory)
          expect(result.exitCode).toBe(0)
          expect(result.stdout.trim()).toBe(expected)
        } finally {
          await sandbox.destroy()
        }
      })

      test("per-call cwd overrides the sandbox-level workingDirectory", async () => {
        const sandbox = await factory.create()
        try {
          const expected = await realpath("/tmp")
          const result = await sandbox.runCommand("pwd", [], { cwd: "/tmp" })
          expect(result.exitCode).toBe(0)
          expect(result.stdout.trim()).toBe(expected)
        } finally {
          await sandbox.destroy()
        }
      })
    })

    describe("env merging", () => {
      test("sandbox-level env is visible to commands", async () => {
        const sandbox = await factory.create({ env: { SIXB_TEST_A: "alpha" } })
        try {
          const result = await sandbox.runCommand("printenv", ["SIXB_TEST_A"])
          expect(result.exitCode).toBe(0)
          expect(result.stdout.trim()).toBe("alpha")
        } finally {
          await sandbox.destroy()
        }
      })

      test("per-call env wins on collision and adds new keys", async () => {
        const sandbox = await factory.create({
          env: { SIXB_TEST_A: "alpha", SIXB_TEST_B: "beta" },
        })
        try {
          const a = await sandbox.runCommand("printenv", ["SIXB_TEST_A"], {
            env: { SIXB_TEST_A: "alpha2", SIXB_TEST_C: "gamma" },
          })
          const b = await sandbox.runCommand("printenv", ["SIXB_TEST_B"], {
            env: { SIXB_TEST_A: "alpha2", SIXB_TEST_C: "gamma" },
          })
          const c = await sandbox.runCommand("printenv", ["SIXB_TEST_C"], {
            env: { SIXB_TEST_A: "alpha2", SIXB_TEST_C: "gamma" },
          })
          expect(a.stdout.trim()).toBe("alpha2")
          expect(b.stdout.trim()).toBe("beta")
          expect(c.stdout.trim()).toBe("gamma")
        } finally {
          await sandbox.destroy()
        }
      })

      test("host secrets are not leaked into the sandbox", async () => {
        const secretKey = "SIXB_HOST_SECRET_DO_NOT_LEAK"
        const previous = process.env[secretKey]
        process.env[secretKey] = "host-only-value"
        try {
          const sandbox = await factory.create()
          try {
            const result = await sandbox.runCommand("printenv", [secretKey])
            expect(result.exitCode).not.toBe(0)
            expect(result.stdout).not.toContain("host-only-value")
          } finally {
            await sandbox.destroy()
          }
        } finally {
          if (previous === undefined) {
            delete process.env[secretKey]
          } else {
            process.env[secretKey] = previous
          }
        }
      })
    })

    describe("timeout and abort", () => {
      test("sleep beyond timeout marks the result timedOut and exits non-zero", async () => {
        const sandbox = await factory.create()
        try {
          const start = Date.now()
          const result = await sandbox.runCommand("sleep", [String(SLEEP_BUDGET_SECONDS)], {
            timeout: shortTimeoutMs,
          })
          const elapsed = Date.now() - start
          expect(result.timedOut).toBe(true)
          expect(result.exitCode).not.toBe(0)
          expect(elapsed).toBeLessThan(SLEEP_BUDGET_SECONDS * 1000)
        } finally {
          await sandbox.destroy()
        }
      })

      test("abort signal aborts an in-flight command", async () => {
        const sandbox = await factory.create()
        try {
          const ac = new AbortController()
          setTimeout(() => ac.abort(), shortTimeoutMs)
          const start = Date.now()
          const result = await sandbox.runCommand("sleep", [String(SLEEP_BUDGET_SECONDS)], {
            signal: ac.signal,
          })
          const elapsed = Date.now() - start
          expect(result.exitCode).not.toBe(0)
          expect(elapsed).toBeLessThan(SLEEP_BUDGET_SECONDS * 1000)
        } finally {
          await sandbox.destroy()
        }
      })

      test("per-call timeout overrides sandbox-level timeout", async () => {
        const sandbox = await factory.create({ timeout: SLEEP_BUDGET_SECONDS * 1000 })
        try {
          const result = await sandbox.runCommand("sleep", [String(SLEEP_BUDGET_SECONDS)], {
            timeout: shortTimeoutMs,
          })
          expect(result.timedOut).toBe(true)
        } finally {
          await sandbox.destroy()
        }
      })
    })

    describe("file materialization", () => {
      test("writeFiles materializes files a subsequent command can read", async () => {
        const sandbox = await factory.create()
        try {
          const flat = `${sandbox.workingDirectory}/materialized.txt`
          const nested = `${sandbox.workingDirectory}/nested/dir/deep.txt`
          await sandbox.writeFiles([
            { path: flat, contents: "flat-contents" },
            { path: nested, contents: "nested-contents" },
          ])

          const flatResult = await sandbox.runCommand("cat", [flat])
          expect(flatResult.exitCode).toBe(0)
          expect(flatResult.stdout).toContain("flat-contents")

          // A nested path proves writeFiles creates missing parent directories.
          const nestedResult = await sandbox.runCommand("cat", [nested])
          expect(nestedResult.exitCode).toBe(0)
          expect(nestedResult.stdout).toContain("nested-contents")
        } finally {
          await sandbox.destroy()
        }
      })

      test("writeFiles round-trips binary contents faithfully", async () => {
        const sandbox = await factory.create()
        try {
          const path = `${sandbox.workingDirectory}/binary.dat`
          const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x0a, 0x7f])
          await sandbox.writeFiles([{ path, contents: bytes }])

          const size = await sandbox.runCommand("wc", ["-c", path])
          expect(size.exitCode).toBe(0)
          expect(size.stdout.trim().split(/\s+/)[0]).toBe(String(bytes.length))

          // od proves the exact bytes survived transport (e.g. a provider's base64 round-trip).
          const hex = await sandbox.runCommand("od", ["-An", "-v", "-tx1", path])
          expect(hex.exitCode).toBe(0)
          expect(hex.stdout.replace(/\s+/g, " ").trim()).toBe("00 01 fe ff 0a 7f")
        } finally {
          await sandbox.destroy()
        }
      })

      test("writeFiles applies an explicit file mode", async () => {
        const sandbox = await factory.create()
        try {
          const path = `${sandbox.workingDirectory}/run.sh`
          await sandbox.writeFiles([{ path, contents: "#!/bin/sh\necho ran\n", mode: 0o755 }])

          // The exec bit is observable, proving mode was honored (not silently dropped).
          const result = await sandbox.runCommand("/bin/sh", ["-c", `test -x ${path} && echo yes`])
          expect(result.exitCode).toBe(0)
          expect(result.stdout).toContain("yes")
        } finally {
          await sandbox.destroy()
        }
      })

      test("writeFiles after stop rejects", async () => {
        const sandbox = await factory.create()
        await sandbox.stop()
        try {
          await expect(
            sandbox.writeFiles([{ path: `${sandbox.workingDirectory}/x.txt`, contents: "x" }])
          ).rejects.toThrow(SandboxNotRunningError)
        } finally {
          await sandbox.destroy()
        }
      })
    })

    if (capabilities.networkBlocking) {
      describe("network isolation", () => {
        test('network.mode="none" blocks outbound DNS / TCP', async () => {
          const sandbox = await factory.create({ network: { mode: "none" } })
          try {
            const result = await sandbox.runCommand("curl", [
              "-sS",
              "--max-time",
              "2",
              "https://example.com",
            ])
            expect(result.exitCode).not.toBe(0)
          } finally {
            await sandbox.destroy()
          }
        })

        test('network.mode="all" permits outbound traffic', async () => {
          const sandbox = await factory.create({ network: { mode: "all" } })
          try {
            const result = await sandbox.runCommand("curl", [
              "-sS",
              "--max-time",
              "5",
              "https://example.com",
            ])
            expect(result.exitCode).not.toBe(6)
          } finally {
            await sandbox.destroy()
          }
        })
      })
    }

    // Restricted per-origin egress is intentionally NOT covered here: the only provider that enforces
    // it (smolvm) can be verified only by a live in-VM network call, which needs a network-capable
    // guest image and outbound internet — infrastructure this suite deliberately avoids so it stays
    // hermetic. smolvm's allow-list flag construction is unit-tested in its network-argv tests
    // instead. Add a conformance slice here once a provider can enforce egress under hermetic tests.

    if (capabilities.readOnlyEnforcement) {
      describe("filesystem isolation", () => {
        test("writing inside readWritePaths succeeds", async () => {
          const sandbox = await factory.create()
          try {
            const result = await sandbox.runCommand("/bin/sh", [
              "-c",
              `echo content > ${sandbox.workingDirectory}/probe.txt && cat ${sandbox.workingDirectory}/probe.txt`,
            ])
            expect(result.exitCode).toBe(0)
            expect(result.stdout.trim()).toBe("content")
          } finally {
            await sandbox.destroy()
          }
        })

        test("writing outside readWritePaths fails", async () => {
          const sandbox = await factory.create()
          try {
            const result = await sandbox.runCommand("/bin/sh", [
              "-c",
              "echo nope > /etc/sixb-sandbox-must-not-write",
            ])
            expect(result.exitCode).not.toBe(0)
          } finally {
            await sandbox.destroy()
          }
        })
      })
    }
  })
}
