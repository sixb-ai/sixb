import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
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
 *
 * The script is written once per file: macOS scans every newly written executable on its first
 * run (~150ms), so a fresh script per test made each test that slow. Each test configures it
 * through a data file instead.
 */

let dir: string
let bin: string
let logPath: string
let configPath: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sixb-smolvm-test-"))
  bin = join(dir, "fake-smolvm.sh")
  logPath = join(dir, "calls.log")
  configPath = join(dir, "config")
  // Logs each invocation; the config line holds "<failOn> <execExit>".
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
read -r failOn execExit < ${JSON.stringify(configPath)}
case "$2" in
  create) [ "$failOn" = "create" ] && exit 1 ;;
  start) [ "$failOn" = "start" ] && exit 1 ;;
  exec)
    # The working-directory bootstrap must always succeed; execExit models the guest command's
    # exit code, which only applies to the caller's runCommand.
    case "$*" in
      *"-- sh -c mkdir -p"*) exit 0 ;;
    esac
    printf 'stdout-from-fake'; printf 'stderr-from-fake' 1>&2; exit "$execExit" ;;
esac
exit 0
`
  await writeFile(bin, script, "utf-8")
  await chmod(bin, 0o755)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(logPath, { force: true })
  await configure()
})

/** Configure the fake for the current test and return its path. */
async function configure(
  opts: { readonly failOn?: "create" | "start"; readonly execExit?: number } = {}
): Promise<string> {
  await writeFile(configPath, `${opts.failOn ?? "none"} ${opts.execExit ?? 0}\n`)
  return bin
}

async function readCalls(): Promise<string[]> {
  const text = await readFile(logPath, "utf-8").catch(() => "")
  return text.split("\n").filter((line) => line.length > 0)
}

describe("SmolvmSandbox lifecycle", () => {
  // Regression check: restore `options.cwd ?? this.workdir.dir` in runCommand;
  // the fake CLI must then receive incorrect relative --workdir arguments.
  test("runCommand resolves working directories, forwards env and maps the CLI result", async () => {
    const sandbox = await SmolvmSandbox.create({
      cli: { bin: await configure({ execExit: 7 }) },
      id: "cwd-test",
      workingDirectory: dir,
      env: { SIXB_RUN_ID: "run-1" },
    })
    try {
      for (const [cwd, expected] of [
        [undefined, sandbox.workingDirectory],
        [".", sandbox.workingDirectory],
        ["nested", `${sandbox.workingDirectory}/nested`],
        ["./nested/..", sandbox.workingDirectory],
        ["/tmp", "/tmp"],
      ] as const) {
        const result = await sandbox.runCommand("bash", ["-lc", "echo hi"], { cwd })
        expect(result).toMatchObject({
          exitCode: 7,
          stdout: "stdout-from-fake",
          stderr: "stderr-from-fake",
        })
        // As the unprivileged user: commands never run as the guest's root.
        expect((await readCalls()).at(-1)).toBe(
          `machine exec --name cwd-test --workdir ${expected} --env SIXB_RUN_ID=run-1 -- setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all -- bash -lc echo hi`
        )
      }
    } finally {
      await sandbox.destroy()
    }
  })

  test("create issues machine create then start in a guest /workspace, and reports running", async () => {
    const sandbox = await SmolvmSandbox.create({
      cli: { bin, image: "node:22-slim" },
      id: "run-1",
    })

    expect(sandbox.status).toBe("running")
    expect(sandbox.provider).toBe("smolvm")
    expect(sandbox.workingDirectory).toBe("/workspace")

    const calls = await readCalls()
    expect(calls[0]).toContain("machine create --name run-1")
    expect(calls[0]).toContain("--image node:22-slim")
    // The guest filesystem is isolated: no host bind mount. Files arrive via in-guest writeFiles.
    expect(calls[0]).not.toContain("--volume")
    expect(calls[1]).toContain("machine start --name run-1")
    // The working directory is created in-guest up front so it is a usable --workdir, and owned by
    // the unprivileged user commands run as.
    expect(calls[2]).toBe(
      'machine exec --name run-1 --workdir / -- sh -c mkdir -p "$1" && chown 65534:65534 "$1" sh /workspace'
    )

    await sandbox.destroy()
  })

  // Guard proof: run writeFiles' script as root again; its exec is not under setpriv. As root, a
  // link a command planted in the working directory would lead the write anywhere.
  test("writes files as the command user, like the commands", async () => {
    const sandbox = await SmolvmSandbox.create({ cli: { bin, image: "x" }, id: "run-1" })
    try {
      await sandbox.writeFiles([{ path: "notes.txt", contents: "x" }])

      const calls = await readCalls()
      const write = calls.find((call) => call.endsWith("sh -c set -e")) ?? ""
      expect(write).toStartWith(
        "machine exec --name run-1 --workdir / -- setpriv --reuid=65534 --regid=65534"
      )
      expect(calls.some((call) => call.includes("chown") && call.includes("notes.txt"))).toBe(false)
    } finally {
      await sandbox.destroy()
    }
  })

  test("destroy stops and removes the machine; later stop/destroy are no-ops and commands reject", async () => {
    const sandbox = await SmolvmSandbox.create({ cli: { bin, image: "x" }, id: "run-1" })

    await sandbox.destroy()
    await sandbox.destroy()
    await sandbox.stop()
    expect(sandbox.status).toBe("stopped")
    const error = await sandbox.runCommand("bash", ["-lc", "echo"]).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SandboxNotRunningError)

    const calls = await readCalls()
    expect(calls.filter((c) => c.includes("machine stop --name run-1"))).toHaveLength(1)
    expect(calls.some((c) => c.includes("machine delete --name run-1"))).toBe(true)
  })

  // Regression check: derive the working directory from a host mkdtemp() path again; the default is
  // then a host path such as /private/var/folders/..., which a non-root image user cannot create.
  test("uses a configured guest working directory and never creates it on the host", async () => {
    const configured = join(dir, "guest-only")
    const sandbox = await SmolvmSandbox.create({
      cli: { bin, image: "x" },
      id: "run-2",
      workingDirectory: configured,
    })
    expect(sandbox.workingDirectory).toBe(configured)
    expect((await readCalls()).at(-1)).toBe(
      `machine exec --name run-2 --workdir / -- sh -c mkdir -p "$1" && chown 65534:65534 "$1" sh ${configured}`
    )
    expect(await stat(configured).catch(() => "absent")).toBe("absent")
    await sandbox.destroy()
  })

  test("create failure throws SandboxError and best-effort removes the machine", async () => {
    const error = await SmolvmSandbox.create({
      cli: { bin: await configure({ failOn: "create" }), image: "x" },
      id: "run-1",
    }).catch((e: unknown) => e)
    expect(String(error)).toContain("smolvm create failed")

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
