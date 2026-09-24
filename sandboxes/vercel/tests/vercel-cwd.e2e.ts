import { describe, expect, test } from "bun:test"
import { posix } from "node:path"
import { VercelSandboxFactory } from "../src/vercel-sandbox-factory"

const guard = process.env.SIXB_VERCEL_SANDBOX_INTEGRATION === "1" ? describe : describe.skip

guard("VercelSandbox working directories (live)", () => {
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
})
