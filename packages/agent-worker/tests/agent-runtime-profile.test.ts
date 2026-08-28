import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import type { CommandResult, RunCommandOptions, Sandbox, SandboxFileRecord } from "@sixb/core"
import { AgentRuntimeProfileError } from "../src/agent-runtime/errors"
import { assertAgentRuntimeProfile } from "../src/agent-runtime/preflight"
import { AGENT_RUNTIME_PROFILE } from "../src/agent-runtime/profile"
import { prepareAgentSandboxApiContext } from "../src/sandbox-api-context"

const PROJECT_ID = "runtime-test"
const ENV = {
  SIXB_API_BASE_URL: "https://capability.invalid/run-secret/",
  SIXB_PROJECT_ID: PROJECT_ID,
}

const SUCCESSFUL_LOCAL_PROBE: CommandResult = {
  exitCode: 0,
  stdout: "node\t22.1.0\tsixb agent CLI 1\n",
  stderr: "",
  durationMs: 1,
}

const SUCCESSFUL_GATEWAY_PROBE: CommandResult = {
  exitCode: 0,
  stdout: JSON.stringify({ id: PROJECT_ID }),
  stderr: "",
  durationMs: 1,
}

interface RecordedCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly options: RunCommandOptions
}

class StubSandbox implements Sandbox {
  readonly id = "stub"
  readonly provider: string
  readonly workingDirectory = "/workspace"
  readonly status = "running" as const
  readonly commands: RecordedCommand[] = []

  constructor(
    private readonly responses: CommandResult[],
    provider = "test-provider"
  ) {
    this.provider = provider
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.commands.push({ command, args, options })
    const response = this.responses.shift()
    if (!response) throw new Error("https://capability.invalid/run-secret/ was unavailable")
    return response
  }

  async writeFiles(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
}

describe("sixb-agent-runtime/v1 preflight", () => {
  test("checks local behavior once, then reaches the gateway through the installed CLI", async () => {
    const sandbox = new StubSandbox([SUCCESSFUL_LOCAL_PROBE, SUCCESSFUL_GATEWAY_PROBE])

    await expect(
      assertAgentRuntimeProfile({ sandbox, env: ENV, projectId: PROJECT_ID })
    ).resolves.toEqual({
      profile: AGENT_RUNTIME_PROFILE,
      provider: "test-provider",
      javascript: { name: "node", version: "22.1.0" },
      cliVersion: "1",
    })

    expect(sandbox.commands).toHaveLength(2)
    expect(sandbox.commands[0]).toMatchObject({ command: "bash", options: { timeout: 15_000 } })
    expect(sandbox.commands[0]?.args[0]).toBe("-lc")
    expect(sandbox.commands[0]?.args[1]).toContain("SIXB_BASH_ENV_READY")
    expect(sandbox.commands[0]?.args[1]).toContain("PIPESTATUS")
    expect(sandbox.commands[0]?.args[1]).toContain("command -v bun")
    expect(sandbox.commands[0]?.args[1]).not.toContain(ENV.SIXB_API_BASE_URL)
    expect(sandbox.commands[1]).toMatchObject({
      command: "bash",
      args: ["-lc", "sixb project show"],
      options: { env: ENV, timeout: 15_000 },
    })
  })

  test("maps behavioral probe exits to stable failed checks", async () => {
    const cases = [
      [20, "environment-bootstrap"],
      [22, "path-bootstrap"],
      [23, "cli-installation"],
      [25, "read-tool"],
      [29, "javascript-runtime"],
      [31, "cli-execution"],
      [127, "bash"],
    ] as const

    for (const [exitCode, check] of cases) {
      const sandbox = new StubSandbox([
        { exitCode, stdout: "", stderr: "untrusted provider output", durationMs: 1 },
      ])
      try {
        await assertAgentRuntimeProfile({ sandbox, env: ENV, projectId: PROJECT_ID })
        throw new Error(`Expected exit ${exitCode} to fail.`)
      } catch (error) {
        expect(error).toBeInstanceOf(AgentRuntimeProfileError)
        expect((error as AgentRuntimeProfileError).check).toBe(check)
      }
    }
  })

  test("rejects runtimes below the supported floor even when the CLI starts", async () => {
    for (const stdout of ["bun\t1.2.9\tsixb agent CLI 1\n", "node\tv21.9.0\tsixb agent CLI 1\n"]) {
      const sandbox = new StubSandbox([{ ...SUCCESSFUL_LOCAL_PROBE, stdout }])
      await expect(
        assertAgentRuntimeProfile({ sandbox, env: ENV, projectId: PROJECT_ID })
      ).rejects.toMatchObject({ check: "javascript-runtime" })
    }
  })

  test("rejects a stale CLI artifact before performing a gateway request", async () => {
    const sandbox = new StubSandbox([
      { ...SUCCESSFUL_LOCAL_PROBE, stdout: "node\t22.1.0\tsixb agent CLI stale\n" },
    ])

    await expect(
      assertAgentRuntimeProfile({ sandbox, env: ENV, projectId: PROJECT_ID })
    ).rejects.toMatchObject({ check: "cli-execution" })
    expect(sandbox.commands).toHaveLength(1)
  })

  test("requires the gateway response to identify the current project", async () => {
    for (const stdout of ["not-json", JSON.stringify({ id: "another-project" })]) {
      const sandbox = new StubSandbox([
        SUCCESSFUL_LOCAL_PROBE,
        { ...SUCCESSFUL_GATEWAY_PROBE, stdout },
      ])
      await expect(
        assertAgentRuntimeProfile({ sandbox, env: ENV, projectId: PROJECT_ID })
      ).rejects.toMatchObject({ check: "gateway-connectivity" })
    }
  })

  test("never exposes the gateway capability URL or raw command diagnostics", async () => {
    const sandbox = new StubSandbox([
      SUCCESSFUL_LOCAL_PROBE,
      {
        exitCode: 3,
        stdout: "",
        stderr: `failed to fetch ${ENV.SIXB_API_BASE_URL}`,
        durationMs: 1,
      },
    ])

    try {
      await assertAgentRuntimeProfile({ sandbox, env: ENV, projectId: PROJECT_ID })
      throw new Error("Expected gateway preflight failure.")
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeProfileError)
      expect(String(error)).not.toContain(ENV.SIXB_API_BASE_URL)
      expect(String(error)).not.toContain("failed to fetch")
      expect(error).toMatchObject({
        provider: "test-provider",
        profile: AGENT_RUNTIME_PROFILE,
        check: "gateway-connectivity",
      })
    }
  })
})

describe("agent runtime conformance", () => {
  let sandbox: HostSandbox | undefined

  afterEach(async () => {
    await sandbox?.destroy()
    sandbox = undefined
  })

  test("the local worker environment satisfies the provisioned behavioral profile", async () => {
    sandbox = await HostSandbox.create()
    const context = await prepareAgentSandboxApiContext({
      sandbox,
      apiBaseUrl: "http://gateway.invalid",
      projectId: PROJECT_ID,
      agentId: "assistant",
      runId: "run-1",
      skills: [],
    })

    const runtime = await assertAgentRuntimeProfile({
      sandbox,
      env: context.env,
      projectId: PROJECT_ID,
    })

    expect(runtime.profile).toBe(AGENT_RUNTIME_PROFILE)
    expect(runtime.provider).toBe("local")
    expect(["bun", "node"]).toContain(runtime.javascript.name)
  })
})

class HostSandbox implements Sandbox {
  readonly id = "host-runtime-conformance"
  readonly provider = "local"
  status: "running" | "stopped" | "failed" = "running"

  private constructor(readonly workingDirectory: string) {}

  static async create(): Promise<HostSandbox> {
    return new HostSandbox(await mkdtemp(join(tmpdir(), "sixb-agent-runtime-")))
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    if (command === "bash" && args.at(-1) === "sixb project show") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ id: PROJECT_ID }),
        stderr: "",
        durationMs: 1,
      }
    }
    const startedAt = performance.now()
    const process = Bun.spawn([command, ...args], {
      cwd: options.cwd ?? this.workingDirectory,
      env: { ...globalThis.process.env, ...(options.env ?? {}) },
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      process.kill()
    }, options.timeout ?? 30_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ])
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: performance.now() - startedAt,
        ...(timedOut ? { timedOut: true } : {}),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    for (const file of files) {
      const path = resolve(this.workingDirectory, file.path)
      const escaped = relative(this.workingDirectory, path)
      if (escaped === ".." || escaped.startsWith("../")) {
        throw new Error("Test sandbox write escaped its root.")
      }
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, file.contents)
      if (file.mode !== undefined) await chmod(path, file.mode)
    }
  }

  async stop(): Promise<void> {
    this.status = "stopped"
  }

  async destroy(): Promise<void> {
    await rm(this.workingDirectory, { recursive: true, force: true })
  }
}
