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

      const path = posix.join(sandbox.workingDirectory, "sixb-live.txt")
      await sandbox.writeFiles([{ path, contents: "from-sixb" }])
      const cat = await sandbox.runCommand("cat", [path])
      expect(cat.exitCode).toBe(0)
      expect(cat.stdout.trim()).toBe("from-sixb")
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)

  // Regression check: restore `options.cwd ?? this.workingDirectory` in runCommand.
  // With @vercel/sandbox 2.9.2, cwd "." runs at / and the relative file read fails.
  test("reads workspace files with omitted, relative, and absolute cwd", async () => {
    const sandbox = await new VercelSandboxFactory({ sessionTimeoutMs: 5 * 60_000 }).create()
    try {
      await sandbox.writeFiles([
        { path: "cwd-root.txt", contents: "workspace-root" },
        { path: "nested/cwd-child.txt", contents: "workspace-child" },
      ])

      for (const [cwd, filename, expected] of [
        [undefined, "cwd-root.txt", "workspace-root"],
        [".", "cwd-root.txt", "workspace-root"],
        ["nested", "cwd-child.txt", "workspace-child"],
        [posix.join(sandbox.workingDirectory, "nested"), "cwd-child.txt", "workspace-child"],
      ] as const) {
        const result = await sandbox.runCommand("cat", [filename], { cwd })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(expected)
      }
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)

  // The simulated transport in the other suites proves what Sixb sends, not what the firewall
  // does with it. This echo shows the guest's own Authorization header replaced by the injected
  // one, and Host forced to the credential's domain.
  test("injects the credential in place of the guest's Authorization header", async () => {
    const origin = "https://postman-echo.com"
    const sandbox = await new VercelSandboxFactory({ sessionTimeoutMs: 5 * 60_000 }).create({
      network: { mode: "restricted", allow: [{ name: "echo", origin }] },
      requestCredentials: [
        {
          origin,
          path: "/headers",
          method: "GET",
          headers: { Authorization: "Bearer sixb-live-injected" },
        },
      ],
    })

    try {
      const result = await sandbox.runCommand("curl", [
        "--silent",
        "--show-error",
        "--fail",
        "--header",
        "Authorization: token placeholder",
        `${origin}/headers`,
      ])
      expect(result.exitCode).toBe(0)

      const echoed: unknown = JSON.parse(result.stdout)
      expect(echoed).toMatchObject({
        headers: { authorization: "Bearer sixb-live-injected", host: "postman-echo.com" },
      })
      expect(result.stdout).not.toContain("placeholder")
    } finally {
      await sandbox.destroy()
    }
  }, 180_000)
})
