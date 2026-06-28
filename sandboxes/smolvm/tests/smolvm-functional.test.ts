import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SmolvmSandboxFactory } from "../src/smolvm-sandbox-factory"

/**
 * End-to-end functional test of the full data path — env injection, working
 * directory, stdout/stderr separation, exit codes, host->guest file visibility,
 * timeout, and abort — driven through SmolvmSandboxFactory exactly as the agent
 * worker would.
 *
 * It uses a faithful fake `smolvm` whose `machine exec` honors smolvm's native
 * `--workdir` and `--env` flags and then runs the forwarded command. Because our
 * volume maps the host workdir to itself (dir:dir), the fake's filesystem view
 * of that directory is identical to a real guest's — so the path bridge is
 * genuinely exercised. The only thing not modeled here is the hypervisor
 * isolation boundary (covered by the real-VM smolvm-integration.test.ts).
 */

let workspace: string
let bin: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "sixb-smolvm-fn-"))
  bin = join(workspace, "fake-smolvm.sh")
  // Faithful emulator: bookkeeping subcommands are no-ops; `machine exec` parses
  // --workdir/--env (as real smolvm does), then runs the command after `--`.
  const script = `#!/bin/sh
case "$2" in
  exec)
    shift 4                      # drop: machine exec --name <id>
    workdir=/
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do
      case "$1" in
        --workdir) workdir="$2"; shift 2 ;;
        --env) export "$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    shift                        # drop --
    cd "$workdir" || exit 1
    exec "$@"
    ;;
  *) exit 0 ;;
esac
`
  await writeFile(bin, script, "utf-8")
  await chmod(bin, 0o755)
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe("SmolvmSandbox functional (faithful guest emulation)", () => {
  function factory(env?: Record<string, string>) {
    return new SmolvmSandboxFactory({ bin, image: "node:22-slim", timeout: 10_000, env })
  }

  test("separates stdout/stderr and reports the real exit code", async () => {
    const sandbox = await factory().create()
    try {
      const result = await sandbox.runCommand("bash", ["-lc", "echo out; echo err 1>&2; exit 3"])
      expect(result.stdout.trim()).toBe("out")
      expect(result.stderr.trim()).toBe("err")
      expect(result.exitCode).toBe(3)
    } finally {
      await sandbox.destroy()
    }
  })

  test("runs commands in workingDirectory and sees files written there on the host", async () => {
    const sandbox = await factory().create()
    try {
      // Mirror what the agent worker's sandbox-api-context does.
      const contextDir = join(sandbox.workingDirectory, ".sixb", "agent", "context")
      await mkdir(contextDir, { recursive: true })
      await writeFile(join(contextDir, "run.json"), '{"runId":"run-1"}', "utf-8")

      const pwd = await sandbox.runCommand("bash", ["-lc", "pwd"])
      expect(await realpath(pwd.stdout.trim())).toBe(await realpath(sandbox.workingDirectory))

      const cat = await sandbox.runCommand("bash", ["-lc", "cat .sixb/agent/context/run.json"])
      expect(cat.exitCode).toBe(0)
      expect(cat.stdout).toContain('"runId":"run-1"')
    } finally {
      await sandbox.destroy()
    }
  })

  test("propagates factory env and the gateway capability URL into the guest", async () => {
    const sandbox = await factory({
      SIXB_API_BASE_URL: "http://127.0.0.1:3002/__sixb/agent-api/run-1/cap",
      SIXB_RUN_ID: "run-1",
    }).create()
    try {
      const result = await sandbox.runCommand("bash", [
        "-lc",
        'echo "$SIXB_RUN_ID@$SIXB_API_BASE_URL"',
      ])
      expect(result.stdout.trim()).toBe("run-1@http://127.0.0.1:3002/__sixb/agent-api/run-1/cap")
    } finally {
      await sandbox.destroy()
    }
  })

  test("per-call env overrides the sandbox default", async () => {
    const sandbox = await factory({ TOKEN: "base" }).create()
    try {
      const result = await sandbox.runCommand("bash", ["-lc", 'echo "$TOKEN"'], {
        env: { TOKEN: "override" },
      })
      expect(result.stdout.trim()).toBe("override")
    } finally {
      await sandbox.destroy()
    }
  })

  test("a network-restricted sandbox still executes local commands", async () => {
    const sandbox = await factory().create({
      network: {
        mode: "restricted",
        allow: [{ name: "sixb-api", origin: "http://127.0.0.1:3002" }],
      },
    })
    try {
      const result = await sandbox.runCommand("bash", ["-lc", "echo ok"])
      expect(result.stdout.trim()).toBe("ok")
    } finally {
      await sandbox.destroy()
    }
  })

  test("times out a runaway command and flags it", async () => {
    const sandbox = await factory().create()
    try {
      const result = await sandbox.runCommand("bash", ["-lc", "sleep 30"], { timeout: 500 })
      expect(result.timedOut).toBe(true)
      expect(result.exitCode).not.toBe(0)
    } finally {
      await sandbox.destroy()
    }
  })

  test("an aborted command is killed", async () => {
    const sandbox = await factory().create()
    try {
      const controller = new AbortController()
      const pending = sandbox.runCommand("bash", ["-lc", "sleep 30"], { signal: controller.signal })
      controller.abort()
      const result = await pending
      expect(result.exitCode).not.toBe(0)
    } finally {
      await sandbox.destroy()
    }
  })
})
