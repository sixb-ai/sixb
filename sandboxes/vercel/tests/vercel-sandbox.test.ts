import { describe, expect, test } from "bun:test"
import { SandboxNotRunningError } from "@sixb/core"
import type {
  VercelCommandClient,
  VercelCommandFinishedClient,
  VercelRunCommandParams,
  VercelSandboxClient,
} from "../src/vercel-sandbox"
import { VercelSandbox } from "../src/vercel-sandbox"
import { type VercelCreateSandbox, VercelSandboxFactory } from "../src/vercel-sandbox-factory"

class FakeFinished implements VercelCommandFinishedClient {
  constructor(
    readonly exitCode: number,
    private readonly out = "stdout-from-vercel",
    private readonly err = "stderr-from-vercel"
  ) {}

  async stdout(): Promise<string> {
    return this.out
  }

  async stderr(): Promise<string> {
    return this.err
  }
}

class FakeCommand implements VercelCommandClient {
  killed = false
  private release: ((value: VercelCommandFinishedClient) => void) | undefined

  constructor(private readonly waitForKill = false) {}

  async wait(): Promise<VercelCommandFinishedClient> {
    if (!this.waitForKill) {
      return new FakeFinished(0)
    }
    if (this.killed) {
      return new FakeFinished(137, "", "killed")
    }
    return await new Promise<VercelCommandFinishedClient>((resolve) => {
      this.release = resolve
    })
  }

  async kill(): Promise<void> {
    this.killed = true
    this.release?.(new FakeFinished(137, "", "killed"))
  }
}

class FakeVercelClient implements VercelSandboxClient {
  readonly commands: VercelRunCommandParams[] = []
  readonly writes: {
    readonly path: string
    readonly content: string | Uint8Array
    readonly mode?: number
  }[][] = []
  readonly commandHandles: FakeCommand[] = []
  stopCalls = 0
  deleteCalls = 0
  status = "running"
  nextCommandWaitsForKill = false

  constructor(
    readonly name = "vercel-sandbox-1",
    readonly cwd = "/vercel/sandbox"
  ) {}

  async runCommand(params: VercelRunCommandParams): Promise<VercelCommandClient> {
    this.commands.push(params)
    const command = new FakeCommand(this.nextCommandWaitsForKill)
    this.nextCommandWaitsForKill = false
    this.commandHandles.push(command)
    return command
  }

  async writeFiles(
    files: readonly {
      readonly path: string
      readonly content: string | Uint8Array
      readonly mode?: number
    }[]
  ): Promise<void> {
    this.writes.push([...files])
  }

  async stop(): Promise<void> {
    this.status = "stopped"
    this.stopCalls += 1
  }

  async delete(): Promise<void> {
    this.deleteCalls += 1
  }
}

describe("VercelSandbox", () => {
  test("runCommand forwards cwd/env/timeout and maps output", async () => {
    const client = new FakeVercelClient()
    const sandbox = new VercelSandbox({ client, env: { A: "factory" }, timeout: 5_000 })

    const result = await sandbox.runCommand("bash", ["-lc", "echo hi"], {
      cwd: "/tmp",
      env: { B: "call" },
      timeout: 123,
    })

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "stdout-from-vercel",
      stderr: "stderr-from-vercel",
    })
    expect(client.commands[0]).toEqual({
      cmd: "bash",
      args: ["-lc", "echo hi"],
      cwd: "/tmp",
      env: { A: "factory", B: "call" },
      detached: true,
      timeoutMs: 123,
    })
  })

  test("writeFiles materializes paths within workingDirectory", async () => {
    const client = new FakeVercelClient()
    const sandbox = new VercelSandbox({ client })

    await sandbox.writeFiles([
      { path: `${sandbox.workingDirectory}/a.txt`, contents: "a", mode: 0o644 },
      { path: "nested/b.txt", contents: new Uint8Array([1, 2]) },
    ])

    expect(client.writes[0]).toEqual([
      { path: "/vercel/sandbox/a.txt", content: "a", mode: 0o644 },
      { path: "/vercel/sandbox/nested/b.txt", content: new Uint8Array([1, 2]) },
    ])
    await expect(sandbox.writeFiles([{ path: "/etc/passwd", contents: "nope" }])).rejects.toThrow(
      "escapes"
    )
  })

  test("timeout kills the remote command and marks the result", async () => {
    const client = new FakeVercelClient()
    client.nextCommandWaitsForKill = true
    const sandbox = new VercelSandbox({ client })

    const result = await sandbox.runCommand("sleep", ["30"], { timeout: 5 })

    expect(result.exitCode).toBe(137)
    expect(result.timedOut).toBe(true)
    expect(client.commandHandles[0].killed).toBe(true)
  })

  test("stop and destroy are idempotent and reject further work", async () => {
    const client = new FakeVercelClient()
    const sandbox = new VercelSandbox({ client })

    await sandbox.stop()
    await sandbox.stop()
    expect(sandbox.status).toBe("stopped")
    expect(client.stopCalls).toBe(1)
    await expect(sandbox.runCommand("echo", ["nope"])).rejects.toBeInstanceOf(
      SandboxNotRunningError
    )

    await sandbox.destroy()
    await sandbox.destroy()
    expect(client.deleteCalls).toBe(1)
  })
})

describe("VercelSandboxFactory", () => {
  test("builds Vercel create params and keeps Sixb command timeout separate", async () => {
    const client = new FakeVercelClient()
    let captured: unknown
    const createRemote: VercelCreateSandbox = async (params) => {
      captured = params
      return client
    }

    const factory = new VercelSandboxFactory(
      {
        credentials: { token: "tok", teamId: "team", projectId: "project" },
        env: { A: "factory" },
        timeout: 111,
        sessionTimeoutMs: 60_000,
        resources: { vcpus: 1 },
      },
      createRemote
    )

    const sandbox = await factory.create({
      env: { B: "call" },
      timeout: 222,
      network: { mode: "none" },
    })

    expect(captured).toMatchObject({
      env: { A: "factory", B: "call" },
      networkPolicy: "deny-all",
      persistent: false,
      timeout: 60_000,
      resources: { vcpus: 1 },
      token: "tok",
      teamId: "team",
      projectId: "project",
    })
    expect((captured as { name: string }).name).toStartWith("sixb-")

    await sandbox.runCommand("echo", ["ok"])
    expect(client.commands[0].timeoutMs).toBe(222)
  })

  test("creates a configured working directory in the remote sandbox", async () => {
    const client = new FakeVercelClient()
    const factory = new VercelSandboxFactory({}, async () => client)

    const sandbox = await factory.create({ workingDirectory: "/workspace/run-1" })

    expect(sandbox.workingDirectory).toBe("/workspace/run-1")
    expect(client.commands[0]).toMatchObject({
      cmd: "mkdir",
      args: ["-p", "/workspace/run-1"],
      cwd: "/",
      env: {},
      detached: true,
      timeoutMs: 30_000,
    })
  })

  test("rejects snapshot configuration conflicts", async () => {
    const factory = new VercelSandboxFactory({ snapshotId: "snap_1", image: "agent:latest" })
    await expect(factory.create()).rejects.toThrow("snapshotId cannot be combined")
  })
})
