import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import type {
  CommandResult,
  RunCommandOptions,
  Sandbox,
  SandboxFileRecord,
  SecurityDefinitionCatalog,
} from "@sixb/core"
import { InMemoryBroker } from "@sixb/core"
import {
  type AgentRunSessionHost,
  NOOP_STREAM_SINK,
  openAgentRunSession,
  type StreamSink,
} from "@sixb/core/internal/agents"
import type { RecoverAiModelCall } from "@sixb/core/internal/model-execution"
import { type RunAgentTurnInput, runAgentTurn } from "../src/run-agent-turn"
import { agentThreadModelContext } from "../src/thread-context"

/** Poll `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 3000
  const intervalMs = options.intervalMs ?? 10
  const start = Date.now()
  for (;;) {
    const value = await fn()
    if (value !== null && value !== undefined && value !== false) {
      return value
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out${options.label ? `: ${options.label}` : ""}`)
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Runs the worker's sandbox scripts in a real local bash against a directory, so symlink, escape,
 * and size checks run as a sandbox would run them. Written files land in the directory. A command
 * past its `timeout` is killed, as a sandbox kills it.
 */
export class LocalBashSandbox implements Sandbox {
  readonly id = "local-bash"
  readonly provider = "test"
  readonly status = "running"

  constructor(readonly workingDirectory: string) {}

  /** As a firewall adds credentials: the URL itself. */
  credentialedUrl(url: string): string {
    return url
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    for (const file of files) {
      const path = isAbsolute(file.path) ? file.path : join(this.workingDirectory, file.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.contents)
    }
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    const script = args.at(-1)
    if (command !== "bash" || typeof script !== "string") {
      throw new Error(`Unexpected command ${command}`)
    }
    const child = Bun.spawn(["bash", "-c", script], {
      cwd: this.workingDirectory,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...options.env },
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, options.timeout)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer))
    return { exitCode, stdout, stderr, durationMs: 0, ...(timedOut ? { timedOut } : {}) }
  }

  async stop(): Promise<void> {}

  async destroy(): Promise<void> {}
}

/** No groups or roles: a direct turn's tests read members, never grants. */
const EMPTY_SECURITY = { groups: [], roles: [] } as unknown as SecurityDefinitionCatalog

/**
 * Run a turn as the worker does, in the session of its run, which the test started already. The
 * session's broker is its own: these tests cancel through their signal, not a published cancel.
 */
export async function runTurnInSession(
  input: Omit<RunAgentTurnInput, "session" | "threadContext"> & {
    /** The history the turn runs on; read through its session, as the worker does, when omitted. */
    readonly threadContext?: RunAgentTurnInput["threadContext"]
    /** Where a model call's record goes when storage cannot take it; dropped when omitted. */
    readonly recoverAiModelCall?: RecoverAiModelCall
    /** Where the turn's live records go; nowhere when omitted. */
    readonly events?: StreamSink
    /** The storage the test seeded, which the turn's session reads and writes. */
    readonly storage: AgentRunSessionHost["storage"]
  }
) {
  const { recoverAiModelCall = async () => {}, events = NOOP_STREAM_SINK, storage, ...turn } = input
  const session = await openAgentRunSession(
    {
      projectId: turn.context.id,
      storage,
      broker: new InMemoryBroker(),
      recoverAiModelCall,
      events,
      security: EMPTY_SECURITY,
      // A turn run directly has no environment, so nothing it does binds the run's SDK.
      sdk: {
        id: turn.context.id,
        withScope: () => {
          throw new Error("A turn run directly reaches no project SDK.")
        },
      },
    },
    turn.run
  )
  try {
    const threadContext =
      turn.threadContext ?? agentThreadModelContext((await session.context()).history)
    return await runAgentTurn({ ...turn, session, threadContext })
  } finally {
    session.close()
  }
}
