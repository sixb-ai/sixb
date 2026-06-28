import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SandboxNotRunningError } from "@sixb/core"
import { SmolvmSandbox } from "../src/smolvm-sandbox"

/**
 * These tests run the real sandbox state machine, exec.ts, and Bun.spawn against
 * a fake `smolvm` shell script. They verify lifecycle wiring (which argv we
 * send), CommandResult mapping, the not-running guard, idempotency, and cleanup
 * — without needing a hypervisor. A real-VM round trip lives in the gated
 * smolvm-integration.test.ts.
 */

let dir: string
let logPath: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sixb-smolvm-test-"))
  logPath = join(dir, "calls.log")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Generate a fake smolvm that logs each invocation and returns controlled codes. */
async function makeFakeSmolvm(
  opts: { readonly failOn?: "create" | "start"; readonly execExit?: number } = {}
): Promise<string> {
  const bin = join(dir, "fake-smolvm.sh")
  const execExit = opts.execExit ?? 0
  const failOn = opts.failOn ?? ""
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
case "$2" in
  create) [ "${failOn}" = "create" ] && exit 1 ;;
  start) [ "${failOn}" = "start" ] && exit 1 ;;
  exec) printf 'stdout-from-fake'; printf 'stderr-from-fake' 1>&2; exit ${execExit} ;;
esac
exit 0
`
  await writeFile(bin, script, "utf-8")
  await chmod(bin, 0o755)
  return bin
}

async function readCalls(): Promise<string[]> {
  const text = await readFile(logPath, "utf-8").catch(() => "")
  return text.split("\n").filter((line) => line.length > 0)
}

describe("SmolvmSandbox lifecycle", () => {
  test("create issues machine create then start, and reports running", async () => {
    const bin = await makeFakeSmolvm()
    const sandbox = await SmolvmSandbox.create({
      cli: { bin, image: "node:22-slim" },
      id: "run-1",
    })

    expect(sandbox.status).toBe("running")
    expect(sandbox.provider).toBe("smolvm")
    expect(sandbox.workingDirectory.length).toBeGreaterThan(0)

    const calls = await readCalls()
    expect(calls[0]).toContain("machine create --name run-1")
    expect(calls[0]).toContain("--image node:22-slim")
    // The host workdir is bind-mounted into the guest at the identical path.
    expect(calls[0]).toContain(`--volume ${sandbox.workingDirectory}:${sandbox.workingDirectory}`)
    expect(calls[1]).toContain("machine start --name run-1")

    await sandbox.destroy()
  })

  test("runCommand sets --workdir/--env and forwards bash -lc, mapping the result", async () => {
    const bin = await makeFakeSmolvm({ execExit: 0 })
    const sandbox = await SmolvmSandbox.create({
      cli: { bin, image: "node:22-slim" },
      id: "run-1",
      env: { SIXB_RUN_ID: "run-1" },
    })

    const result = await sandbox.runCommand("bash", ["-lc", "echo hi"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("stdout-from-fake")
    expect(result.stderr).toBe("stderr-from-fake")

    const execCall = (await readCalls()).find((c) => c.includes("machine exec"))
    expect(execCall).toContain("machine exec --name run-1")
    expect(execCall).toContain(`--workdir ${sandbox.workingDirectory}`)
    expect(execCall).toContain("--env SIXB_RUN_ID=run-1")
    expect(execCall).toContain("-- bash -lc echo hi")

    await sandbox.destroy()
  })

  test("propagates the guest exit code", async () => {
    const bin = await makeFakeSmolvm({ execExit: 7 })
    const sandbox = await SmolvmSandbox.create({ cli: { bin, image: "x" }, id: "run-1" })
    const result = await sandbox.runCommand("bash", ["-lc", "exit 7"])
    expect(result.exitCode).toBe(7)
    await sandbox.destroy()
  })

  test("runCommand after stop rejects with SandboxNotRunningError", async () => {
    const bin = await makeFakeSmolvm()
    const sandbox = await SmolvmSandbox.create({ cli: { bin, image: "x" }, id: "run-1" })
    await sandbox.stop()
    expect(sandbox.status).toBe("stopped")
    expect(sandbox.runCommand("bash", ["-lc", "echo"])).rejects.toThrow(SandboxNotRunningError)
    await sandbox.destroy()
  })

  test("stop and destroy are idempotent", async () => {
    const bin = await makeFakeSmolvm()
    const sandbox = await SmolvmSandbox.create({ cli: { bin, image: "x" }, id: "run-1" })
    await sandbox.stop()
    await sandbox.stop()
    await sandbox.destroy()
    await sandbox.destroy()
    expect(sandbox.status).toBe("stopped")
  })

  test("destroy stops, removes the machine, and cleans up the temp workdir", async () => {
    const bin = await makeFakeSmolvm()
    const sandbox = await SmolvmSandbox.create({ cli: { bin, image: "x" }, id: "run-1" })
    const wd = sandbox.workingDirectory

    await sandbox.destroy()

    const calls = await readCalls()
    expect(calls.some((c) => c.includes("machine stop --name run-1"))).toBe(true)
    expect(calls.some((c) => c.includes("machine delete --name run-1"))).toBe(true)
    expect(stat(wd)).rejects.toThrow()
  })

  test("create failure throws SandboxError and best-effort removes the machine", async () => {
    const bin = await makeFakeSmolvm({ failOn: "create" })
    expect(SmolvmSandbox.create({ cli: { bin, image: "x" }, id: "run-1" })).rejects.toThrow(
      "smolvm create failed"
    )

    const calls = await readCalls()
    expect(calls.some((c) => c.includes("machine delete --name run-1"))).toBe(true)
  })
})

describe("SmolvmSandbox registry egress", () => {
  const restricted = {
    mode: "restricted",
    allow: [{ name: "sixb-api", origin: "http://10.0.0.5:3002" }],
  } as const

  test("a registry image adds the registry hosts to the restricted allow list", async () => {
    const bin = await makeFakeSmolvm()
    const sandbox = await SmolvmSandbox.create({
      cli: { bin, image: "node:22" },
      id: "run-1",
      network: restricted,
      registryHosts: ["index.docker.io", "auth.docker.io"],
    })
    const create = (await readCalls())[0]
    expect(create).toContain("--allow-host 10.0.0.5") // gateway preserved
    expect(create).toContain("--allow-host index.docker.io") // registry added
    await sandbox.destroy()
  })

  test("a local image archive stays strict (no registry egress)", async () => {
    const bin = await makeFakeSmolvm()
    const sandbox = await SmolvmSandbox.create({
      cli: { bin, image: "/images/agent.tar" },
      id: "run-1",
      network: restricted,
      registryHosts: ["index.docker.io", "auth.docker.io"],
    })
    const create = (await readCalls())[0]
    expect(create).toContain("--allow-host 10.0.0.5") // gateway only
    expect(create).not.toContain("docker.io")
    await sandbox.destroy()
  })
})
