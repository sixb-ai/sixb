import { describe, expect, test } from "bun:test"
import { posix } from "node:path"
import { VercelSandboxFactory } from "../src/vercel-sandbox-factory"

/**
 * Live Vercel Sandbox smoke test. Disabled by default because it requires Vercel credentials and
 * consumes metered sandbox resources. Run with SIXB_VERCEL_SANDBOX_INTEGRATION=1.
 */
const guard = process.env.SIXB_VERCEL_SANDBOX_INTEGRATION === "1" ? describe : describe.skip

guard("VercelSandbox (live)", () => {
  test("runs commands and reads materialized files", async () => {
    const sandbox = await new VercelSandboxFactory({ sessionTimeoutMs: 5 * 60_000 }).create()
    try {
      const echo = await sandbox.runCommand("bash", ["-lc", "echo vercel-ok"])
      expect(echo.exitCode).toBe(0)
      expect(echo.stdout.trim()).toBe("vercel-ok")

      // Regression: detached commands required a second logs request, which could fail when a command
      // (such as an empty generated-file scan) emitted no stdout or stderr.
      const silent = await sandbox.runCommand("true")
      expect(silent).toMatchObject({ exitCode: 0, stdout: "", stderr: "" })

      const path = posix.join(sandbox.workingDirectory, "sixb-live.txt")
      await sandbox.writeFiles([{ path, contents: "from-sixb" }])
      const cat = await sandbox.runCommand("cat", [path])
      expect(cat.exitCode).toBe(0)
      expect(cat.stdout.trim()).toBe("from-sixb")
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)
})
