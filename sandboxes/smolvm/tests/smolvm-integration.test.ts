import { beforeAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { probeSmolvm } from "../src/preflight"
import { SmolvmSandbox, type SmolvmSandboxOptions } from "../src/smolvm-sandbox"

/**
 * Real-VM round trip against an installed `smolvm`. Skips cleanly (describe.skip)
 * when the binary or host virtualization is unavailable, like the local backend's
 * *-integration.test.ts.
 *
 * Uses a BARE machine (no image) on purpose: it boots fully offline from the
 * built-in busybox rootfs, so the test needs no Docker and no prebuilt archive
 * in CI. It validates the real lifecycle, the dir:dir volume mount, --workdir,
 * --env, exit codes, and stream separation end to end. The rootfs ships busybox
 * `sh` (not bash), so commands use `sh`. (The factory defaults to the managed
 * bash+curl image; that path is covered by the manual build + docs.)
 */
const available = probeSmolvm("smolvm").ok
const guard = available ? describe : describe.skip

// Bare machine: no image => offline. Generous timeout: first boot is slow.
function createBare(options: Partial<SmolvmSandboxOptions> = {}) {
  return SmolvmSandbox.create({ cli: { bin: "smolvm" }, timeout: 120_000, ...options })
}

guard("SmolvmSandbox (real bare VM)", () => {
  beforeAll(() => {
    if (!available) {
      console.warn("[smolvm integration] smolvm/virtualization unavailable; skipping")
    }
  })

  test("separates stdout/stderr and reports the real exit code", async () => {
    const sandbox = await createBare()
    try {
      const result = await sandbox.runCommand("sh", ["-lc", "echo out; echo err 1>&2; exit 3"])
      expect(result.stdout.trim()).toBe("out")
      expect(result.stderr.trim()).toBe("err")
      expect(result.exitCode).toBe(3)
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)

  test("guest sees files written to workingDirectory on the host (dir:dir mount)", async () => {
    const sandbox = await createBare()
    try {
      const contextDir = join(sandbox.workingDirectory, ".sixb", "agent", "context")
      await mkdir(contextDir, { recursive: true })
      await writeFile(join(contextDir, "run.json"), '{"ok":true}', "utf-8")

      const result = await sandbox.runCommand("sh", ["-lc", "cat .sixb/agent/context/run.json"])
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('"ok":true')
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)

  test("runs in workingDirectory and injects env vars", async () => {
    const sandbox = await createBare({ env: { SIXB_RUN_ID: "run-xyz" } })
    try {
      const pwd = await sandbox.runCommand("sh", ["-lc", "pwd"])
      expect(pwd.stdout.trim()).toBe(sandbox.workingDirectory)

      const env = await sandbox.runCommand("sh", ["-lc", 'echo "$SIXB_RUN_ID"'])
      expect(env.stdout.trim()).toBe("run-xyz")
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)

  test("times out a runaway command", async () => {
    const sandbox = await createBare()
    try {
      const result = await sandbox.runCommand("sh", ["-lc", "sleep 30"], { timeout: 2_000 })
      expect(result.timedOut).toBe(true)
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)
})
