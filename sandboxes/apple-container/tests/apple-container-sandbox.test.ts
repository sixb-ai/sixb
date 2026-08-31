import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SandboxNotRunningError } from "@sixb/core"
import { AppleContainerSandbox } from "../src/apple-container-sandbox"
import { DEFAULT_APPLE_CONTAINER_IMAGE } from "../src/apple-container-sandbox-factory"
import type { AppleContainerCliConfig } from "../src/cli"

let dir: string
let logPath: string

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "sixb-apple-container-test-")))
  logPath = join(dir, "container-calls.ndjson")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("AppleContainerSandbox lifecycle", () => {
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
  const bin = join(dir, "fake-container.js")
  const failOncePath = join(dir, "fake-container-fail-once")
  const source = `#!${process.execPath}
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

const logPath = ${JSON.stringify(logPath)};
const failOn = ${JSON.stringify(options.failOn ?? "")};
const failOnceOn = ${JSON.stringify(options.failOnceOn ?? "")};
const failOncePath = ${JSON.stringify(failOncePath)};
const args = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(args) + "\\n");

const command = args[0];
if (command === "network") {
  if (args[1] === "delete" && failOnceOn === "network-delete" && !existsSync(failOncePath)) {
    writeFileSync(failOncePath, "1");
    console.error("forced network delete failure");
    process.exit(9);
  }
  process.exit(0);
}
if (command === "create") {
  if (failOn === "create") {
    console.error("forced create failure");
    process.exit(7);
  }
  process.exit(0);
}
if (command === "start") {
  if (failOn === "start") {
    console.error("forced start failure");
    process.exit(8);
  }
  process.exit(0);
}
if (command === "stop" || command === "delete") {
  process.exit(0);
}
if (command !== "exec") {
  console.error("unsupported command: " + command);
  process.exit(2);
}

let index = 1;
let interactive = false;
let cwd = process.cwd();
const env = { ...process.env };

while (args[index]?.startsWith("-")) {
  const option = args[index++];
  if (option === "--interactive" || option === "-i") {
    interactive = true;
  } else if (option === "--env" || option === "-e") {
    const assignment = args[index++];
    const split = assignment.indexOf("=");
    env[assignment.slice(0, split)] = assignment.slice(split + 1);
  } else if (option === "--workdir" || option === "--cwd" || option === "-w") {
    cwd = args[index++];
    mkdirSync(cwd, { recursive: true });
  } else {
    console.error("unsupported exec option: " + option);
    process.exit(2);
  }
}

index += 1;
const processArgs = args.slice(index);
const child = spawn(processArgs[0], processArgs.slice(1), {
  cwd,
  env,
  stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
});

if (interactive) {
  process.stdin.pipe(child.stdin);
}

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("close", (code) => process.exit(code ?? 1));
`
  await writeFile(bin, source, "utf8")
  await chmod(bin, 0o755)
  return {
    bin,
    image: "node:test",
    mounts: [],
    ports: [],
    dns: [],
    createArgs: [],
  }
}

async function readCalls(): Promise<string[][]> {
  const text = await readFile(logPath, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[])
}
