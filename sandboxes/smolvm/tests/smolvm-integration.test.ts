import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { probeSmolvm } from "../src/preflight"
import { SmolvmSandbox } from "../src/smolvm-sandbox"

/**
 * Real-VM round trip against an installed `smolvm`. Skips cleanly (describe.skip)
 * when the binary or host virtualization is unavailable, like the local backend's
 * *-integration.test.ts.
 *
 * Uses a BARE machine (no image) on purpose: it boots fully offline from the
 * built-in busybox rootfs, so the test needs no Docker and no prebuilt archive
 * in CI. It validates the real lifecycle, in-guest file materialization via
 * writeFiles, --workdir, --env, exit codes, and stream separation end to end.
 * The rootfs ships busybox `sh` (not bash), so commands use `sh`.
 *
 * The cases share one VM: each boot costs most of a second and none of them changes what the
 * others observe. The runaway command runs last because its guest process outlives the killed
 * exec session until destroy reaps the VM.
 */
const available = probeSmolvm("smolvm").ok
const guard = available ? describe : describe.skip

guard("SmolvmSandbox (real bare VM)", () => {
  let sandbox: SmolvmSandbox

  // Bare machine: no image => offline. Generous timeout: first boot is slow.
  beforeAll(async () => {
    sandbox = await SmolvmSandbox.create({
      cli: { bin: "smolvm" },
      timeout: 120_000,
      env: { SIXB_RUN_ID: "run-xyz" },
    })
  }, 180_000)

  afterAll(async () => {
    await sandbox?.destroy()
  }, 180_000)

  test("separates stdout/stderr and reports the real exit code", async () => {
    const result = await sandbox.runCommand("sh", ["-lc", "echo out; echo err 1>&2; exit 3"])
    expect(result.stdout.trim()).toBe("out")
    expect(result.stderr.trim()).toBe("err")
    expect(result.exitCode).toBe(3)
  }, 180_000)

  test("guest reads files materialized in-guest via writeFiles", async () => {
    const runContextPath = join(sandbox.workingDirectory, ".sixb", "agent", "context", "run.json")
    await sandbox.writeFiles([{ path: runContextPath, contents: '{"ok":true}' }])

    const result = await sandbox.runCommand("sh", ["-lc", "cat .sixb/agent/context/run.json"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"ok":true')
  }, 180_000)

  test("runs in workingDirectory and injects env vars", async () => {
    // The bare rootfs links /workspace to /storage/workspace, so compare physical paths.
    const pwd = await sandbox.runCommand("sh", ["-lc", "pwd -P"])
    const resolved = await sandbox.runCommand("realpath", [sandbox.workingDirectory])
    expect(pwd.stdout.trim()).toBe(resolved.stdout.trim())

    const env = await sandbox.runCommand("sh", ["-lc", 'echo "$SIXB_RUN_ID"'])
    expect(env.stdout.trim()).toBe("run-xyz")
  }, 180_000)

  test("times out a runaway command", async () => {
    const result = await sandbox.runCommand("sh", ["-lc", "sleep 30"], { timeout: 500 })
    expect(result.timedOut).toBe(true)
  }, 180_000)
})
