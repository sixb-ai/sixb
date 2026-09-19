import { beforeAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { AzureSandboxFactory } from "../src"

import { buildGuestArtifact } from "./guest-build"

// Opt-in: an existing disposable group and data-plane RBAC are required.
// Uses DefaultAzureCredential. Never stores credentials or creates role assignments.
const enabled = process.env.SIXB_AZURE_E2E === "1"
beforeAll(async () => {
  if (enabled) await buildGuestArtifact()
}, 20_000)
function createFactory() {
  return new AzureSandboxFactory({
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
    sandboxGroup: process.env.AZURE_SANDBOX_GROUP!,
    region: process.env.AZURE_SANDBOX_REGION ?? "westus3",
    image: { type: "public", name: "node-22" },
    resources: { vcpus: 1, memoryMiB: 2048, diskGiB: 20 },
    workingDirectory: `/workspace/test '${randomUUID()}`,
    env: { BASE: "base", OVERRIDE: "old" },
    timeout: 10_000,
    pollIntervalMs: 200,
  })
}

test.skipIf(!enabled)(
  "Azure supervised execution and lifecycle",
  async () => {
    const factory = createFactory()
    const sandbox = await factory.create()
    console.log(`[AzureE2E] Created ${sandbox.id}`)
    try {
      const args = ["", "space arg", "'\"$HOME`", "$(touch /tmp/sixb-injected)", "line\nnext", "雪"]
      const result = await sandbox.runCommand(
        "node",
        [
          "-e",
          "console.log(JSON.stringify({args:process.argv.slice(1),env:process.env,uid:process.getuid(),cwd:process.cwd()}));console.error('separate stderr');process.exitCode=7",
          "--",
          ...args,
        ],
        { env: { OVERRIDE: "new", SPECIAL: "quotes '\" $HOME\n雪" } }
      )
      expect(result.exitCode).toBe(7)
      expect(result.stderr).toBe("separate stderr\n")
      const observed = JSON.parse(result.stdout)
      expect(observed.args).toEqual(args)
      expect(observed.uid).toBe(65534)
      expect(observed.cwd).toBe(sandbox.workingDirectory)
      expect(observed.env).toMatchObject({
        BASE: "base",
        OVERRIDE: "new",
        SPECIAL: "quotes '\" $HOME\n雪",
      })
      expect(observed.env.AZURE_SUBSCRIPTION_ID).toBeUndefined()
      expect(result.durationMs).toBeGreaterThan(0)
      expect((await sandbox.runCommand("sixb-missing-binary")).exitCode).toBe(127)
      expect((await sandbox.runCommand("pwd", [], { cwd: "/tmp" })).stdout.trim()).toBe("/tmp")
      console.log("[AzureE2E] argv, environment, cwd and result mapping passed")

      const privilege = await sandbox.runCommand("cat", ["/proc/self/status"])
      expect(privilege.stdout).toMatch(/NoNewPrivs:\s+1/)
      expect(privilege.stdout).toMatch(/CapEff:\s+0+/)
      expect(
        (await sandbox.runCommand("bash", ["-c", "ls /run/sixb-*/supervisor.mjs >/dev/null 2>&1"]))
          .exitCode
      ).not.toBe(0)
      await sandbox.runCommand("bash", [
        "-c",
        "setsid bash -c 'sleep 2; echo survived > background-marker' </dev/null >/dev/null 2>&1 & echo done",
      ])

      const timeout = await sandbox.runCommand(
        "bash",
        [
          "-c",
          "setsid bash -c 'sleep 2; echo survived > timeout-marker' </dev/null >/dev/null 2>&1 & echo ready; sleep 30",
        ],
        { timeout: 500 }
      )
      expect(timeout.timedOut).toBe(true)
      expect(timeout.exitCode).toBe(137)
      expect(timeout.stdout).toContain("ready")
      await sandbox.runCommand("sleep", ["2.2"])
      expect((await sandbox.runCommand("test", ["!", "-e", "timeout-marker"])).exitCode).toBe(0)
      expect((await sandbox.runCommand("test", ["!", "-e", "background-marker"])).exitCode).toBe(0)
      // Negative control: replace cgroup.kill write with a no-op. The detached child
      // survives timeout and the preceding marker assertion fails on the live guest.
      console.log("[AzureE2E] timeout killed detached descendants; sandbox reusable")

      const abort = new AbortController()
      const command = sandbox.runCommand(
        "bash",
        [
          "-c",
          "setsid bash -c 'sleep 3; echo survived > abort-marker' </dev/null >/dev/null 2>&1 & touch abort-ready; echo partial; sleep 30",
        ],
        { signal: abort.signal }
      )
      const handled = command.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      try {
        for (let i = 0; i < 20; i++) {
          if ((await sandbox.runCommand("test", ["-f", "abort-ready"])).exitCode === 0) break
          if (i === 19) throw new Error("command did not start")
        }
      } finally {
        abort.abort()
      }
      const outcome = await handled
      if (!("value" in outcome)) throw outcome.error
      expect(outcome.value.exitCode).toBe(137)
      expect(outcome.value.timedOut).toBeUndefined()
      expect(outcome.value.stdout).toContain("partial")
      await sandbox.runCommand("sleep", ["3.2"])
      expect((await sandbox.runCommand("test", ["!", "-e", "abort-marker"])).exitCode).toBe(0)
      const preAborted = await sandbox.runCommand("touch", ["preabort-marker"], {
        signal: AbortSignal.abort(),
      })
      expect(preAborted.exitCode).toBe(137)
      expect((await sandbox.runCommand("test", ["!", "-e", "preabort-marker"])).exitCode).toBe(0)
      console.log("[AzureE2E] cancellation, concurrency and pre-abort passed")

      // No system DNS escape through the initial per-command network namespace.
      const dns = await sandbox.runCommand(
        "node",
        ["-e", "require('node:dns').lookup('example.com',e=>process.exit(e?0:1))"],
        { timeout: 5000 }
      )
      expect(dns.exitCode === 0 || dns.timedOut === true).toBe(true)
      const pending = sandbox.runCommand("sleep", ["30"])
      const stopping = sandbox.stop()
      expect((await pending).exitCode).toBe(137)
      await stopping
      expect(sandbox.status).toBe("stopped")
      await expect(sandbox.runCommand("true")).rejects.toThrow("stopped")
      console.log("[AzureE2E] network isolation and stop passed")
    } finally {
      await sandbox.destroy()
      console.log(`[AzureE2E] Deleted ${sandbox.id}`)
    }
  },
  180_000
)

test.skipIf(!enabled)(
  "Azure output overflow fails closed and reclaims the VM",
  async () => {
    const sandbox = await createFactory().create()
    console.log(`[AzureE2E] Created overflow test ${sandbox.id}`)
    try {
      await expect(
        sandbox.runCommand("node", ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"])
      ).rejects.toThrow("1 MiB")
      expect(sandbox.status).toBe("failed")
      await expect(sandbox.runCommand("true")).rejects.toThrow("failed")
    } finally {
      await sandbox.destroy()
      console.log(`[AzureE2E] Deleted overflow test ${sandbox.id}`)
    }
  },
  90_000
)
