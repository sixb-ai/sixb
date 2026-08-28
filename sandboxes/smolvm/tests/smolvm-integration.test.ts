import { beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { defaultAgentImageCandidates } from "../src/agent-image"
import { probeSmolvm } from "../src/preflight"
import { SmolvmSandbox, type SmolvmSandboxOptions } from "../src/smolvm-sandbox"

/**
 * Real-VM round trip against an installed `smolvm`. Skips cleanly (describe.skip)
 * when the binary or host virtualization is unavailable, like the local backend's
 * *-integration.test.ts.
 *
 * Uses a BARE machine (no image) on purpose: it boots fully offline from the
 * built-in busybox rootfs, so the test needs no Docker and no prebuilt archive
 * in CI. It validates the real lifecycle, in-guest file materialization via
 * writeFiles, --workdir, --env, exit codes, and stream separation end to end.
 * The rootfs ships busybox `sh` (not bash), so commands use `sh`. (The factory
 * defaults to the managed runtime-v1 image; that path is covered by the manual
 * build + docs.)
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

  test("guest reads files materialized in-guest via writeFiles", async () => {
    const sandbox = await createBare()
    try {
      const runContextPath = join(sandbox.workingDirectory, ".sixb", "agent", "context", "run.json")
      await sandbox.writeFiles([{ path: runContextPath, contents: '{"ok":true}' }])

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

const managedImage = defaultAgentImageCandidates().find((candidate) => existsSync(candidate))
const managedGuard =
  available && managedImage && process.env.SIXB_SMOLVM_AGENT_RUNTIME_INTEGRATION === "1"
    ? describe
    : describe.skip

managedGuard("SmolvmSandbox (managed agent runtime)", () => {
  test("satisfies the agent-runtime command profile", async () => {
    if (!managedImage) throw new Error("Expected a built managed agent image.")
    const sandbox = await SmolvmSandbox.create({
      cli: { bin: "smolvm", image: managedImage },
      timeout: 120_000,
      network: { mode: "none" },
    })
    try {
      const bashEnv = join(sandbox.workingDirectory, "runtime", "bash-env")
      const fixture = join(sandbox.workingDirectory, "runtime", "probe.txt")
      await sandbox.writeFiles([
        { path: bashEnv, contents: "export SIXB_BASH_ENV_READY=1\n" },
        { path: fixture, contents: "first\nsixb-runtime-probe\nthird\n" },
      ])
      const runtime = await sandbox.runCommand("bash", ["-lc", RUNTIME_COMMAND_PROBE], {
        env: { BASH_ENV: bashEnv, SIXB_RUNTIME_PROBE_FILE: fixture },
      })
      expect(runtime.exitCode).toBe(0)
      expect(runtime.stdout.trim()).toMatch(/^node:v?\d+\.\d+/)
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)
})

const RUNTIME_COMMAND_PROBE = `set -u
[ "\${SIXB_BASH_ENV_READY:-}" = "1" ] || exit 20
for command_name in realpath tail head base64; do
  command_path="$(command -v "$command_name" || true)"
  [ -n "$command_path" ] || exit 21
done
probe="$(tail -n "+2" -- "$SIXB_RUNTIME_PROBE_FILE" | head -n 1 | head -c 19 | base64)"
[ "$probe" = "c2l4Yi1ydW50aW1lLXByb2JlCg==" ] || exit 22
node_version="$(node --version)" || exit 23
node_major="\${node_version#v}"
node_major="\${node_major%%.*}"
[ "$node_major" -ge 22 ] || exit 23
printf 'node:%s\n' "$node_version"`
