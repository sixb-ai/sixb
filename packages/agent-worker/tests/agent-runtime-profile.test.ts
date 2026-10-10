import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { CommandResult, RunCommandOptions, Sandbox } from "@sixb/core"
import { LocalSandboxFactory } from "@sixb/sandboxes-local"
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
  stdout: JSON.stringify({
    ok: true,
    profile: AGENT_RUNTIME_PROFILE,
    cli: { version: "1" },
    javascript: { name: "node", version: "22.1.0" },
    project: { id: PROJECT_ID },
  }),
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

  private readonly delayMs: number

  constructor(
    private readonly responses: CommandResult[],
    options: { readonly provider?: string; readonly delayMs?: number } = {}
  ) {
    this.provider = options.provider ?? "test-provider"
    this.delayMs = options.delayMs ?? 0
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.commands.push({ command, args, options })
    if (this.delayMs > 0 && this.commands.length > 1) await Bun.sleep(this.delayMs)
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
    ).resolves.toBeUndefined()

    expect(sandbox.commands).toHaveLength(2)
    expect(sandbox.commands[0]).toMatchObject({ command: "bash", options: { timeout: 15_000 } })
    expect(sandbox.commands[0]?.args[0]).toBe("-lc")
    expect(sandbox.commands[0]?.args[1]).toContain("SIXB_BASH_ENV_READY")
    expect(sandbox.commands[0]?.args[1]).toContain("PIPESTATUS")
    expect(sandbox.commands[0]?.args[1]).toContain("command -v bun")
    expect(sandbox.commands[0]?.args[1]).not.toContain(ENV.SIXB_API_BASE_URL)
    expect(sandbox.commands[1]).toMatchObject({
      command: "bash",
      args: ["-lc", "sixb doctor"],
      options: { env: ENV, timeout: 15_000 },
    })
  })

  test("maps behavioral probe exits to stable failed checks", async () => {
    const cases = [
      [20, "environment-bootstrap"],
      [21, "path-bootstrap"],
      [22, "cli-installation"],
      [23, "file-tools"],
      [24, "javascript-runtime"],
      [25, "cli-execution"],
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
        expect((error as AgentRuntimeProfileError).reason).toBe("nonzero-exit")
        expect((error as AgentRuntimeProfileError).exitCode).toBe(exitCode)
      }
    }
  })

  test("classifies probe timeouts and command failures without retaining diagnostics", async () => {
    const cases = [
      {
        sandbox: new StubSandbox([
          {
            exitCode: 137,
            stdout: "",
            stderr: `timed out while using ${ENV.SIXB_API_BASE_URL}`,
            durationMs: 15_000,
            timedOut: true,
          },
        ]),
        check: "bash",
        reason: "timed-out",
      },
      {
        sandbox: new StubSandbox([]),
        check: "bash",
        reason: "command-error",
      },
      {
        sandbox: new StubSandbox([SUCCESSFUL_LOCAL_PROBE]),
        check: "gateway-connectivity",
        reason: "command-error",
      },
    ] as const

    for (const { sandbox, check, reason } of cases) {
      try {
        await assertAgentRuntimeProfile({ sandbox, env: ENV, projectId: PROJECT_ID })
        throw new Error(`Expected ${reason} to fail.`)
      } catch (error) {
        expect(error).toMatchObject({ check, reason, exitCode: undefined })
        expect(String(error)).not.toContain(ENV.SIXB_API_BASE_URL)
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
    const wrongProject = JSON.stringify({
      ...JSON.parse(SUCCESSFUL_GATEWAY_PROBE.stdout),
      project: { id: "another-project" },
    })
    for (const stdout of ["not-json", wrongProject]) {
      const sandbox = new StubSandbox([
        SUCCESSFUL_LOCAL_PROBE,
        { ...SUCCESSFUL_GATEWAY_PROBE, stdout },
      ])
      try {
        await assertAgentRuntimeProfile({ sandbox, env: ENV, projectId: PROJECT_ID })
        throw new Error("Expected doctor validation to fail.")
      } catch (error) {
        expect(error).toMatchObject({
          check: stdout === "not-json" ? "cli-execution" : "gateway-connectivity",
          reason: "invalid-output",
        })
      }
    }
  })

  test("retries the gateway while the API restarts, then fails as before if it stays down", async () => {
    // Regression proof: call runProbe once in probeGateway; every case below fails on its first
    // transient response.
    const unreachable: CommandResult = {
      exitCode: 3,
      stdout: "",
      stderr: `${JSON.stringify({ error: { code: "api_unreachable", message: "unreachable" } })}\n`,
      durationMs: 1,
    }
    const unavailable: CommandResult = {
      ...unreachable,
      stderr: JSON.stringify({ error: { code: "http_error", status: 503, message: "busy" } }),
    }
    const timedOut: CommandResult = { ...unreachable, exitCode: 137, stderr: "", timedOut: true }

    const recovering = new StubSandbox([
      SUCCESSFUL_LOCAL_PROBE,
      unreachable,
      unavailable,
      timedOut,
      SUCCESSFUL_GATEWAY_PROBE,
    ])
    await expect(
      assertAgentRuntimeProfile({
        sandbox: recovering,
        env: ENV,
        projectId: PROJECT_ID,
        gatewayRetryDelaysMs: [1, 1, 1, 1],
      })
    ).resolves.toBeUndefined()
    expect(recovering.commands).toHaveLength(5)

    const down = new StubSandbox([SUCCESSFUL_LOCAL_PROBE, ...Array(5).fill(unreachable)])
    await expect(
      assertAgentRuntimeProfile({
        sandbox: down,
        env: ENV,
        projectId: PROJECT_ID,
        gatewayRetryDelaysMs: [1, 1, 1, 1],
      })
    ).rejects.toMatchObject({ check: "gateway-connectivity", reason: "nonzero-exit", exitCode: 3 })
    expect(down.commands).toHaveLength(6)
  })

  test("bounds gateway retries by a short window after the first probe", async () => {
    // Regression proof: give every retry the full probe timeout and ignore the window; the
    // retried timeouts grow past the window and the probe count reaches the backoff list's length.
    const unreachable: CommandResult = {
      exitCode: 3,
      stdout: "",
      stderr: JSON.stringify({ error: { code: "api_unreachable", message: "unreachable" } }),
      durationMs: 100,
    }
    const slow = new StubSandbox([SUCCESSFUL_LOCAL_PROBE, ...Array(20).fill(unreachable)], {
      delayMs: 100,
    })
    const startedAt = Date.now()
    await expect(
      assertAgentRuntimeProfile({
        sandbox: slow,
        env: ENV,
        projectId: PROJECT_ID,
        gatewayRetryDelaysMs: Array(20).fill(1),
        gatewayRetryWindowMs: 1_500,
      })
    ).rejects.toMatchObject({ check: "gateway-connectivity", exitCode: 3 })
    expect(Date.now() - startedAt).toBeLessThan(1_500 + 300)
    const probes = slow.commands.slice(1)
    expect(probes.length).toBeLessThan(8)
    expect(probes[0]?.options.timeout).toBe(15_000)
    for (const retry of probes.slice(1)) expect(retry.options.timeout).toBeLessThanOrEqual(1_500)

    // A first probe that used its full timeout has outlived the window: it is not retried.
    const hung = new StubSandbox(
      [SUCCESSFUL_LOCAL_PROBE, { ...unreachable, exitCode: 137, stderr: "", timedOut: true }],
      { delayMs: 50 }
    )
    await expect(
      assertAgentRuntimeProfile({
        sandbox: hung,
        env: ENV,
        projectId: PROJECT_ID,
        gatewayRetryDelaysMs: [1, 1, 1, 1],
        gatewayRetryWindowMs: 30,
      })
    ).rejects.toMatchObject({ check: "gateway-connectivity", reason: "timed-out" })
    expect(hung.commands).toHaveLength(2)
  })

  test("never retries a gateway that answers, rejects the run, or cannot start the CLI", async () => {
    const rejected: CommandResult = {
      exitCode: 3,
      stdout: "",
      stderr: JSON.stringify({ error: { code: "forbidden", status: 403, message: "denied" } }),
      durationMs: 1,
    }
    const wrongProject = JSON.stringify({
      ...JSON.parse(SUCCESSFUL_GATEWAY_PROBE.stdout),
      project: { id: "another-project" },
    })
    const cases = [
      { response: rejected, check: "gateway-connectivity", reason: "nonzero-exit" },
      { response: { ...rejected, stderr: "not json" }, check: "gateway-connectivity" },
      { response: { ...rejected, exitCode: 1 }, check: "gateway-connectivity" },
      {
        response: { ...SUCCESSFUL_GATEWAY_PROBE, stdout: wrongProject },
        check: "gateway-connectivity",
        reason: "invalid-output",
      },
    ] as const

    for (const { response, ...failure } of cases) {
      const sandbox = new StubSandbox([SUCCESSFUL_LOCAL_PROBE, response, SUCCESSFUL_GATEWAY_PROBE])
      await expect(
        assertAgentRuntimeProfile({
          sandbox,
          env: ENV,
          projectId: PROJECT_ID,
          gatewayRetryDelaysMs: [1, 1, 1, 1],
        })
      ).rejects.toMatchObject(failure)
      expect(sandbox.commands).toHaveLength(2)
    }

    const local = new StubSandbox([
      { exitCode: 22, stdout: "", stderr: "", durationMs: 1 },
      SUCCESSFUL_LOCAL_PROBE,
    ])
    await expect(
      assertAgentRuntimeProfile({ sandbox: local, env: ENV, projectId: PROJECT_ID })
    ).rejects.toMatchObject({ check: "cli-installation" })
    expect(local.commands).toHaveLength(1)
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
  let sandbox: Sandbox | undefined

  afterEach(async () => {
    await sandbox?.destroy()
    sandbox = undefined
  })

  test("the local worker environment satisfies the provisioned behavioral profile", async () => {
    sandbox = await createLocalSandbox()
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/api/project") {
          return Response.json({ id: PROJECT_ID, name: "Runtime test" })
        }
        return new Response("Not found", { status: 404 })
      },
    })
    const context = await prepareAgentSandboxApiContext({
      sandbox,
      apiBaseUrl: `http://127.0.0.1:${server.port}`,
      projectId: PROJECT_ID,
      actorId: "assistant",
      runId: "run-1",
      skills: [],
    })

    try {
      await expect(
        assertAgentRuntimeProfile({
          sandbox,
          env: context.env,
          projectId: PROJECT_ID,
        })
      ).resolves.toBeUndefined()
    } finally {
      await server.stop(true)
    }
  })

  test("rejects an environment whose output-collection utilities do not behave correctly", async () => {
    sandbox = await createLocalSandbox()
    const context = await prepareAgentSandboxApiContext({
      sandbox,
      apiBaseUrl: "http://gateway.invalid",
      projectId: PROJECT_ID,
      actorId: "assistant",
      runId: "run-1",
      skills: [],
    })
    const shimDir = join(sandbox.workingDirectory, "broken-tools")
    await mkdir(shimDir, { recursive: true })
    await writeFile(join(shimDir, "find"), "#!/bin/sh\nexit 1\n")
    await chmod(join(shimDir, "find"), 0o755)
    const bashEnvPath = context.env.BASH_ENV
    if (!bashEnvPath) throw new Error("Expected the worker to materialize BASH_ENV.")
    await sandbox.writeFiles([
      {
        path: bashEnvPath,
        contents: [
          "# Test a behaviorally incompatible file utility.",
          `export PATH="$SIXB_BIN_DIR:${shimDir}:$PATH"`,
          "export SIXB_BASH_ENV_READY=1",
          "",
        ].join("\n"),
      },
    ])

    await expect(
      assertAgentRuntimeProfile({
        sandbox,
        env: context.env,
        projectId: PROJECT_ID,
      })
    ).rejects.toMatchObject({ check: "file-tools", reason: "nonzero-exit", exitCode: 23 })
  })
})

async function createLocalSandbox(): Promise<Sandbox> {
  return await new LocalSandboxFactory({
    isolation: "none",
    network: { mode: "all" },
  }).create()
}
