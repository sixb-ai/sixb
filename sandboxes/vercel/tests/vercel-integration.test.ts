import { describe, expect, test } from "bun:test"
import { posix } from "node:path"
import { VercelSandboxFactory } from "../src/vercel-sandbox-factory"

/**
 * Live Vercel Sandbox smoke test. Disabled by default because it requires Vercel credentials and
 * consumes metered sandbox resources. Run with SIXB_VERCEL_SANDBOX_INTEGRATION=1.
 */
const guard = process.env.SIXB_VERCEL_SANDBOX_INTEGRATION === "1" ? describe : describe.skip

guard("VercelSandbox (live)", () => {
  test("satisfies the agent-runtime command profile and reads materialized files", async () => {
    const sandbox = await new VercelSandboxFactory({ sessionTimeoutMs: 5 * 60_000 }).create()
    try {
      const echo = await sandbox.runCommand("bash", ["-lc", "echo vercel-ok"])
      expect(echo.exitCode).toBe(0)
      expect(echo.stdout.trim()).toBe("vercel-ok")

      const path = posix.join(sandbox.workingDirectory, "sixb-live.txt")
      await sandbox.writeFiles([{ path, contents: "from-sixb" }])
      const cat = await sandbox.runCommand("cat", [path])
      expect(cat.exitCode).toBe(0)
      expect(cat.stdout.trim()).toBe("from-sixb")

      const bashEnv = posix.join(sandbox.workingDirectory, "runtime", "bash-env")
      const fixture = posix.join(sandbox.workingDirectory, "runtime", "probe.txt")
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
