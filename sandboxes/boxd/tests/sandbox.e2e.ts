import { describe, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync } from "node:fs"
import { GUEST_CREDENTIAL_PATHS } from "@sixb/core/sandboxes"
import { runSandboxesContractSuite } from "@sixb/core/testing"
import { LIVE_TIMEOUT_MS, liveEnabled, liveFactory } from "./live"

// Run with: SIXB_BOXD_E2E=1 bun test --timeout 300000 ./sandboxes/boxd/tests/sandbox.e2e.ts
// The shared suite compares `pwd` with the working directory as this host resolves it, so the
// live run uses a directory that exists on both sides.
const CONTRACT_DIRECTORY = "/tmp/sixb-boxd-e2e"

if (liveEnabled) {
  mkdirSync(CONTRACT_DIRECTORY, { recursive: true })
  runSandboxesContractSuite("BoxdSandbox (live)", {
    createFactory: () => liveFactory({ timeout: 60_000, workingDirectory: CONTRACT_DIRECTORY }),
    capabilities: { networkBlocking: true },
    // A command crosses the network to the machine: give it time to start before the deadline.
    shortTimeoutMs: 2_000,
  })
}

describe.skipIf(!liveEnabled)("BoxdSandbox on a real machine", () => {
  test(
    "runs commands as the unprivileged user with exact argv, env and exit codes",
    async () => {
      const sandbox = await liveFactory({ env: { BASE: "base", OVERRIDE: "old" } }).create()
      try {
        const args = [
          "",
          "space arg",
          "'\"$HOME`",
          "$(touch /tmp/sixb-injected)",
          "line\nnext",
          "雪",
        ]
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
        expect(observed.env.BOXD_API_KEY).toBeUndefined()
        expect((await sandbox.runCommand("ls", ["/tmp/sixb-injected"])).exitCode).not.toBe(0)
        expect((await sandbox.runCommand("sixb-missing-binary")).exitCode).toBe(127)

        const missing = await sandbox.runCommand("pwd", [], { cwd: "/sixb-missing-directory" })
        expect(missing.exitCode).toBe(1)
        expect(missing.stderr).toContain("working directory '/sixb-missing-directory'")
      } finally {
        await sandbox.destroy()
      }
    },
    LIVE_TIMEOUT_MS
  )

  test(
    "keeps commands away from root and the machine's own user",
    async () => {
      const sandbox = await liveFactory().create()
      try {
        const sudo = await sandbox.runCommand("sudo", ["-n", "id"])
        expect(sudo.exitCode).not.toBe(0)
        const state = await sandbox.runCommand("ls", [GUEST_CREDENTIAL_PATHS.state])
        expect(state.exitCode).not.toBe(0)
        const home = await sandbox.runCommand("ls", ["/home/boxd"])
        expect(home.exitCode).not.toBe(0)
      } finally {
        await sandbox.destroy()
      }
    },
    LIVE_TIMEOUT_MS
  )

  test(
    "round-trips a 5 MiB binary file and keeps a background process between calls",
    async () => {
      const sandbox = await liveFactory({ timeout: 60_000 }).create()
      try {
        const bytes = new Uint8Array(randomBytes(5 * 1024 * 1024))
        const digest = createHash("sha256").update(bytes).digest("hex")
        await sandbox.writeFiles([{ path: "data/blob.bin", contents: bytes }])
        const sum = await sandbox.runCommand("sha256sum", ["data/blob.bin"])
        expect(sum.exitCode).toBe(0)
        expect(sum.stdout.split(" ")[0]).toBe(digest)

        // A command can leave a server running for the next one, as an agent's dev server does.
        const started = await sandbox.runCommand("sh", [
          "-c",
          "setsid sh -c 'echo $$ > server.pid; exec sleep 300' </dev/null >/dev/null 2>&1 &",
        ])
        expect(started.exitCode).toBe(0)
        await Bun.sleep(1_000)
        const alive = await sandbox.runCommand("sh", ["-c", 'kill -0 "$(cat server.pid)"'])
        expect(alive.exitCode).toBe(0)
      } finally {
        await sandbox.destroy()
      }
    },
    LIVE_TIMEOUT_MS
  )

  test(
    "keeps the output a command wrote before its timeout",
    async () => {
      const sandbox = await liveFactory().create()
      try {
        const result = await sandbox.runCommand(
          "sh",
          ["-c", "echo before; echo err-before >&2; sleep 30; echo after"],
          { timeout: 3_000 }
        )
        expect(result.timedOut).toBe(true)
        expect(result.exitCode).toBe(137)
        expect(result.stdout).toBe("before\n")
        expect(result.stderr).toBe("err-before\n")
        const sleeping = await sandbox.runCommand("sh", [
          "-c",
          "ps -eo args | grep -c '^sleep 30$'",
        ])
        expect(sleeping.stdout.trim()).toBe("0")
      } finally {
        await sandbox.destroy()
      }
    },
    LIVE_TIMEOUT_MS
  )

  test(
    "reaches only the allowed origins under a restricted network",
    async () => {
      const sandbox = await liveFactory().create({
        network: {
          mode: "restricted",
          allow: [{ name: "example", origin: "https://example.com" }],
        },
      })
      try {
        const curl = (url: string) =>
          sandbox.runCommand("curl", [
            "-sS",
            "-m",
            "10",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            url,
          ])
        const allowed = await curl("https://example.com")
        expect(allowed.exitCode).toBe(0)
        expect(allowed.stdout).toBe("200")
        expect((await curl("https://github.com")).exitCode).not.toBe(0)
      } finally {
        await sandbox.destroy()
      }
    },
    LIVE_TIMEOUT_MS
  )
})
