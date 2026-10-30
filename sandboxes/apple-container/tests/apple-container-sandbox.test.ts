import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SandboxNotRunningError } from "@sixb/core"
import { unprivilegedGuestArgv } from "@sixb/core/sandboxes"
import { AppleContainerSandbox } from "../src/apple-container-sandbox"
import {
  AppleContainerSandboxFactory,
  DEFAULT_APPLE_CONTAINER_IMAGE,
} from "../src/apple-container-sandbox-factory"
import type { AppleContainerCliConfig } from "../src/cli"
import * as preflight from "../src/preflight"

let dir: string
let binDir: string
let bin: string
let logPath: string
let configPath: string
let failOncePath: string

// The fake CLI is written once per file: macOS scans each newly written executable on its first
// run (~150ms), so a fresh script per test made every test that slow. Tests configure it through
// a data file instead.
beforeAll(async () => {
  binDir = await realpath(await mkdtemp(join(tmpdir(), "sixb-apple-container-bin-")))
  bin = join(binDir, "fake-container.sh")
  logPath = join(binDir, "container-calls.log")
  configPath = join(binDir, "config")
  failOncePath = join(binDir, "fake-container-fail-once")
  await writeFile(bin, fakeCliSource(), "utf8")
  await chmod(bin, 0o755)
  // The guest's commands run unprivileged through setpriv, and its files are chowned to that user.
  // The fake runs them as the test's own user, so both are stand-ins: setpriv runs what follows
  // its `--`.
  await mkdir(join(binDir, "stubs"))
  const stub = async (name: string, body: string) => {
    await writeFile(join(binDir, "stubs", name), `#!/bin/sh\n${body}\n`, "utf8")
    await chmod(join(binDir, "stubs", name), 0o755)
  }
  await stub("setpriv", 'while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"')
  await stub("chown", "exit 0")
})

afterAll(async () => {
  await rm(binDir, { recursive: true, force: true })
})

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "sixb-apple-container-test-")))
  await rm(logPath, { force: true })
  await rm(failOncePath, { force: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("AppleContainerSandbox lifecycle", () => {
  test.each([
    undefined,
    { setup: ["touch override-marker"] },
  ])("factory applies only the selected setup: %j", async (environment) => {
    // Regression proof: initialize only options.environment; the default-marker case fails.
    const cli = await fakeCli()
    const probe = spyOn(preflight, "probeAppleContainer").mockReturnValue({
      ok: true,
      message: "Fake CLI",
    })
    try {
      const factory = new AppleContainerSandboxFactory({
        bin: cli.bin,
        setup: ["touch default-marker"],
      })
      const sandbox = await factory.create({ workingDirectory: dir, environment })
      try {
        expect((await sandbox.runCommand("test", ["-f", "default-marker"])).exitCode).toBe(
          environment === undefined ? 0 : 1
        )
        expect((await sandbox.runCommand("test", ["-f", "override-marker"])).exitCode).toBe(
          environment?.setup ? 0 : 1
        )
      } finally {
        await sandbox.destroy()
      }
    } finally {
      probe.mockRestore()
    }
  })

  // Regression check: restore `options.cwd ?? this.workingDirectory` in runCommand;
  // the relative-path cases then fail to read the workspace files.
  test("resolves command working directories before invoking the CLI", async () => {
    const sandbox = await AppleContainerSandbox.create({
      cli: await fakeCli(),
      id: "cwd-test",
      workingDirectory: dir,
    })
    try {
      await sandbox.writeFiles([
        { path: "cwd-probe.txt", contents: "root" },
        { path: "nested/cwd-probe.txt", contents: "child" },
      ])
      for (const [cwd, expectedDirectory, expectedContent] of [
        [undefined, dir, "root"],
        [".", dir, "root"],
        ["nested", `${dir}/nested`, "child"],
        ["./nested/..", dir, "root"],
        [`${dir}/nested`, `${dir}/nested`, "child"],
      ] as const) {
        const result = await sandbox.runCommand("cat", ["cwd-probe.txt"], { cwd })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(expectedContent)
        // As the unprivileged user: commands never run as the guest's root.
        expect((await readCalls()).at(-1)).toEqual([
          "exec",
          "--workdir",
          expectedDirectory,
          "cwd-test",
          ...unprivilegedGuestArgv("cat", ["cwd-probe.txt"]),
        ])
      }
    } finally {
      await sandbox.destroy()
    }
  })

  test("pins the production Node image to an immutable OCI index", () => {
    expect(DEFAULT_APPLE_CONTAINER_IMAGE).toMatch(/^node:22-bookworm@sha256:[a-f0-9]{64}$/)
  })

  test("create starts a long-lived container on an internal network", async () => {
    const cli = await fakeCli()
    const sandbox = await AppleContainerSandbox.create({
      cli,
      id: "run-1",
      workingDirectory: dir,
      network: { mode: "none" },
    })

    expect(sandbox.provider).toBe("apple-container")
    expect(sandbox.status).toBe("running")
    expect(sandbox.workingDirectory).toBe(dir)

    const calls = await readCalls()
    expect(calls[0]).toEqual(["network", "create", "--internal", "sixb-apple-net-run-1"])
    expect(calls[1]).toContain("create")
    expect(calls[1]).toContain("--network")
    expect(calls[1]).toContain("sixb-apple-net-run-1")
    expect(calls[1]).toContain("node:test")
    expect(calls[2]).toEqual(["start", "run-1"])

    await sandbox.destroy()
  })

  test("runCommand forwards cwd/env/timeout and maps command output", async () => {
    const cli = await fakeCli()
    const sandbox = await AppleContainerSandbox.create({
      cli,
      id: "run-1",
      workingDirectory: dir,
      env: { BASE: "factory" },
    })

    const result = await sandbox.runCommand("/bin/sh", ["-c", 'printf "%s" "$BASE:$CALL:$(pwd)"'], {
      env: { CALL: "call" },
      timeout: 1_000,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(`factory:call:${dir}`)
    expect(result.stderr).toBe("")

    const execCall = (await readCalls()).find(
      (call) => call[0] === "exec" && call.includes("BASE=factory")
    )
    expect(execCall).toContain("--env")
    expect(execCall).toContain("CALL=call")
    expect(execCall).toContain("--workdir")
    expect(execCall).toContain(dir)

    await sandbox.destroy()
  })

  test("writeFiles streams binary contents, applies modes, and confines paths", async () => {
    const cli = await fakeCli()
    const sandbox = await AppleContainerSandbox.create({
      cli,
      id: "run-1",
      workingDirectory: dir,
    })

    const scriptPath = join(dir, "nested", "run.sh")
    const binaryPath = join(dir, "binary.dat")
    const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff, 0x0a, 0x7f])
    await sandbox.writeFiles([
      { path: scriptPath, contents: "#!/bin/sh\necho ok\n", mode: 0o755 },
      { path: binaryPath, contents: bytes },
    ])

    expect(await readFile(scriptPath, "utf8")).toBe("#!/bin/sh\necho ok\n")
    expect((await stat(scriptPath)).mode & 0o111).not.toBe(0)
    expect(new Uint8Array(await readFile(binaryPath))).toEqual(bytes)

    await expect(sandbox.writeFiles([{ path: "/etc/passwd", contents: "nope" }])).rejects.toThrow(
      "escapes"
    )

    await sandbox.destroy()
  })

  test("stop and destroy are idempotent and reject later work", async () => {
    const cli = await fakeCli()
    const sandbox = await AppleContainerSandbox.create({
      cli,
      id: "run-1",
      workingDirectory: dir,
    })

    await sandbox.stop()
    await sandbox.stop()
    expect(sandbox.status).toBe("stopped")
    await expect(sandbox.runCommand("echo", ["nope"])).rejects.toBeInstanceOf(
      SandboxNotRunningError
    )

    await sandbox.destroy()
    await sandbox.destroy()
    const calls = await readCalls()
    expect(calls.filter((call) => call[0] === "stop")).toHaveLength(1)
    expect(calls.filter((call) => call[0] === "delete")).toHaveLength(1)
    expect(calls.filter((call) => call[0] === "network" && call[1] === "delete")).toHaveLength(1)
  })

  test("create failure cleans up the container and owned network", async () => {
    const cli = await fakeCli({ failOn: "create" })
    await expect(
      AppleContainerSandbox.create({
        cli,
        id: "run-1",
        workingDirectory: dir,
      })
    ).rejects.toThrow("apple-container create failed")

    const calls = await readCalls()
    expect(calls.some((call) => call[0] === "delete" && call.includes("run-1"))).toBe(true)
    expect(calls.some((call) => call[0] === "network" && call[1] === "delete")).toBe(true)
  })

  test("destroy retries network cleanup after container deletion succeeds", async () => {
    const cli = await fakeCli({ failOnceOn: "network-delete" })
    const sandbox = await AppleContainerSandbox.create({
      cli,
      id: "run-1",
      workingDirectory: dir,
    })

    await expect(sandbox.destroy()).rejects.toThrow("network delete failed")
    await sandbox.destroy()

    const calls = await readCalls()
    expect(calls.filter((call) => call[0] === "delete")).toHaveLength(1)
    expect(calls.filter((call) => call[0] === "network" && call[1] === "delete")).toHaveLength(2)
  })
})

async function fakeCli(
  options: { readonly failOn?: "create" | "start"; readonly failOnceOn?: "network-delete" } = {}
): Promise<AppleContainerCliConfig> {
  await writeFile(configPath, `${options.failOn ?? "none"} ${options.failOnceOn ?? "none"}\n`)
  return {
    bin,
    image: "node:test",
    mounts: [],
    ports: [],
    dns: [],
    createArgs: [],
  }
}

/**
 * A POSIX shell stand-in for the `container` CLI. It logs each call as unit-separated arguments,
 * and `exec` applies --env/--workdir and then execs the command on the host, so stdin (writeFiles)
 * and signals (timeouts) reach it directly.
 */
function fakeCliSource(): string {
  return `#!/bin/sh
{ printf '%s\\037' "$@"; printf '\\036'; } >> ${JSON.stringify(logPath)}
read -r failOn failOnceOn < ${JSON.stringify(configPath)}
case "$1" in
  network)
    if [ "$2" = delete ] && [ "$failOnceOn" = network-delete ] && [ ! -e ${JSON.stringify(failOncePath)} ]; then
      : > ${JSON.stringify(failOncePath)}
      echo "forced network delete failure" >&2; exit 9
    fi
    exit 0 ;;
  create) if [ "$failOn" = create ]; then echo "forced create failure" >&2; exit 7; fi; exit 0 ;;
  start) if [ "$failOn" = start ]; then echo "forced start failure" >&2; exit 8; fi; exit 0 ;;
  stop|delete) exit 0 ;;
  exec) shift ;;
  *) echo "unsupported command: $1" >&2; exit 2 ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --interactive) shift ;;
    --env) export "$2"; shift 2 ;;
    --workdir) mkdir -p "$2" && cd "$2" || exit 1; shift 2 ;;
    -*) echo "unsupported exec option: $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
shift
PATH=${JSON.stringify(join(binDir, "stubs"))}:"$PATH" exec "$@"
`
}

async function readCalls(): Promise<string[][]> {
  const text = await readFile(logPath, "utf8").catch(() => "")
  return text
    .split("\x1e")
    .filter((call) => call.length > 0)
    .map((call) => call.split("\x1f").slice(0, -1))
}
