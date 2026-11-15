import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CommandResult,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  SandboxNotRunningError,
  type SandboxSessionOptions,
  type SandboxStatus,
} from "@sixb/core"
import { APIError, type NetworkPolicy } from "@vercel/sandbox"
import { withRequestCredentials } from "./network"

const DEFAULT_WORKING_DIRECTORY = "/vercel/sandbox"
const KILLED_EXIT_CODE = 137

/**
 * Set on every command, and so inherited by every process it starts. Killing the command kills
 * only its own process: a shell's child that outlives it keeps the command's output open, and
 * Vercel reports no end until that output closes. A timeout or a stop kills them all by this.
 */
export const COMMAND_MARKER = "SIXB_SANDBOX_COMMAND"

/** How long a killed command may take to report its end before the call returns without it. */
export const KILLED_COMMAND_GRACE_MS = 5_000

/** Kills every process whose environment carries the marker its one argument names. */
const KILL_MARKED_PROCESSES = `marker="$1"
for proc in /proc/[0-9]*; do
  if tr '\\0' '\\n' < "$proc/environ" 2>/dev/null | grep -qxF -- "$marker"; then
    kill -KILL "\${proc#/proc/}" 2>/dev/null
  fi
done
true`

export interface VercelRunCommandParams {
  readonly cmd: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly detached: true
  readonly timeoutMs?: number
}

export interface VercelCommandFinishedClient {
  readonly exitCode: number
  stdout(opts?: { readonly signal?: AbortSignal }): Promise<string>
  stderr(opts?: { readonly signal?: AbortSignal }): Promise<string>
}

export interface VercelCommandClient {
  wait(params?: { readonly signal?: AbortSignal }): Promise<VercelCommandFinishedClient>
  kill(signal?: "SIGKILL", opts?: { readonly abortSignal?: AbortSignal }): Promise<void>
}

export interface VercelSandboxClient {
  /** Replace the network policy of this client's session only, never the sandbox defaults. */
  readonly updateNetworkPolicy?: (policy: NetworkPolicy) => Promise<void>
  readonly name: string
  readonly cwd?: string
  readonly status?: string
  runCommand(params: VercelRunCommandParams): Promise<VercelCommandClient>
  writeFiles(
    files: readonly {
      readonly path: string
      readonly content: string | Uint8Array
      readonly mode?: number
    }[],
    opts?: { readonly signal?: AbortSignal }
  ): Promise<void>
  stop(opts?: { readonly signal?: AbortSignal }): Promise<unknown>
  delete(opts?: { readonly signal?: AbortSignal }): Promise<void>
}

export interface VercelSandboxOptions extends SandboxSessionOptions {
  readonly id?: string
  readonly client: VercelSandboxClient
}

/** Sandbox wrapper around a Vercel Sandbox SDK instance. */
export class VercelSandbox implements Sandbox {
  readonly setRequestCredentials?: Sandbox["setRequestCredentials"]
  readonly credentialedUrl?: Sandbox["credentialedUrl"]
  readonly id: string
  readonly provider = "vercel"
  readonly workingDirectory: string

  private currentStatus: SandboxStatus = "running"
  private readonly client: VercelSandboxClient
  private readonly sandboxEnv: Readonly<Record<string, string>>
  private readonly defaultTimeoutMs: number | undefined
  private readonly inFlight = new Set<VercelCommandClient>()
  private destroyed = false
  private stopPromise: Promise<void> | undefined

  constructor(options: VercelSandboxOptions) {
    this.client = options.client
    this.id = options.id ?? options.client.name
    this.workingDirectory = normalizeWorkingDirectory(
      options.workingDirectory ?? options.client.cwd
    )
    this.sandboxEnv = options.env ?? {}
    this.defaultTimeoutMs = options.timeout
    if (options.client.updateNetworkPolicy) {
      const updateNetworkPolicy = options.client.updateNetworkPolicy.bind(options.client)
      const network = options.network

      // The firewall adds a credential to a matching request on its way out: commands call the
      // URL itself.
      this.credentialedUrl = (url) => url
      // Each update replaces the session policy: configured egress plus these exact targets.
      this.setRequestCredentials = async (credentials) => {
        this.assertRunning("update request credentials")
        const policy = withRequestCredentials(network, credentials)

        try {
          await updateNetworkPolicy(policy)
        } catch {
          // SDK request errors can include the injected headers.
          throw new SandboxError("[Sandbox] Vercel credential injection update failed.")
        }
      }
    }
  }

  get status(): SandboxStatus {
    if (this.currentStatus !== "running") {
      return this.currentStatus
    }
    if (this.client.status === "failed" || this.client.status === "aborted") {
      return "failed"
    }
    if (
      this.client.status === "stopped" ||
      this.client.status === "stopping" ||
      this.client.status === "snapshotting"
    ) {
      return "stopped"
    }
    return "running"
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.assertRunning("run commands")

    const start = Date.now()
    const timeoutMs = options.timeout ?? this.defaultTimeoutMs
    const env = { ...this.sandboxEnv, ...(options.env ?? {}) }
    const cwd = posix.resolve(this.workingDirectory, options.cwd ?? ".")

    if (options.signal?.aborted) {
      return abortedResult(start)
    }

    let timedOut = false
    let aborted = false
    let killStarted = false
    let commandHandle: VercelCommandClient
    const marker = randomUUID()

    try {
      commandHandle = await this.client.runCommand({
        cmd: command,
        args: [...args],
        cwd,
        env: { ...env, [COMMAND_MARKER]: marker },
        detached: true,
        ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
      })
    } catch (error) {
      if (isSessionStopped(error)) throw this.sessionStopped()
      throw new SandboxError(
        `[Sandbox] vercel runCommand failed for ${this.id}: ${errorMessage(error)}`
      )
    }

    this.inFlight.add(commandHandle)

    // Once killed, the call waits a little for the command to report its end, then returns
    // without it: a process nothing could kill must not hold the run.
    let giveUp: () => void = () => {}
    const givenUp = new Promise<typeof GIVEN_UP>((resolve) => {
      giveUp = () => resolve(GIVEN_UP)
    })
    let grace: ReturnType<typeof setTimeout> | undefined

    const kill = (): void => {
      if (killStarted) {
        return
      }
      killStarted = true
      commandHandle.kill("SIGKILL").catch(() => {})
      void this.killMarkedProcesses(marker)
      grace = setTimeout(giveUp, KILLED_COMMAND_GRACE_MS)
    }

    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            kill()
          }, timeoutMs)
        : undefined

    const onAbort = (): void => {
      aborted = true
      // A stop after a timeout already killed the command: its caller waits no longer.
      if (killStarted) giveUp()
      else kill()
    }
    options.signal?.addEventListener("abort", onAbort)
    if (options.signal?.aborted) {
      onAbort()
    }

    const killedResult = (): CommandResult => ({
      exitCode: KILLED_EXIT_CODE,
      stdout: "",
      stderr: timedOut
        ? `[Sandbox] command timed out after ${timeoutMs}ms`
        : "[Sandbox] command aborted",
      durationMs: Date.now() - start,
      ...(timedOut ? { timedOut: true } : {}),
    })

    const ended = commandHandle.wait().then(async (finished) => {
      const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()])
      return { exitCode: finished.exitCode, stdout, stderr }
    })
    // Given up on, it may still fail later: that failure is nobody's to hear.
    ended.catch(() => {})

    try {
      const outcome = await Promise.race([ended, givenUp])
      if (outcome === GIVEN_UP) return killedResult()

      return {
        exitCode: normalizeExitCode(outcome.exitCode, killStarted),
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        durationMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
      }
    } catch (error) {
      if (timedOut || aborted) return killedResult()
      if (isSessionStopped(error)) throw this.sessionStopped()

      throw new SandboxError(
        `[Sandbox] vercel command failed for ${this.id}: ${errorMessage(error)}`
      )
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      if (grace !== undefined) {
        clearTimeout(grace)
      }
      options.signal?.removeEventListener("abort", onAbort)
      this.inFlight.delete(commandHandle)
    }
  }

  /**
   * Kill whatever a killed command left running. Best effort: a sandbox that stops meanwhile
   * reaps them itself.
   */
  private async killMarkedProcesses(marker: string): Promise<void> {
    try {
      const killer = await this.client.runCommand({
        cmd: "sh",
        args: ["-c", KILL_MARKED_PROCESSES, "sh", `${COMMAND_MARKER}=${marker}`],
        cwd: "/",
        detached: true,
        timeoutMs: KILLED_COMMAND_GRACE_MS,
      })
      await killer.wait()
    } catch {
      // The sandbox stopped, or the processes already ended.
    }
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    this.assertRunning("write files")
    if (files.length === 0) {
      return
    }

    const mapped = files.map((file) => ({
      path: this.resolveWithinWorkingDirectory(file.path),
      content: file.contents,
      ...(file.mode !== undefined ? { mode: file.mode } : {}),
    }))

    try {
      await this.client.writeFiles(mapped)
    } catch (error) {
      if (isSessionStopped(error)) throw this.sessionStopped()
      throw new SandboxError(
        `[Sandbox] vercel writeFiles failed for ${this.id}: ${errorMessage(error)}`
      )
    }
  }

  async stop(): Promise<void> {
    // Concurrent/repeated callers must await the same confirmed outcome, including failure.
    if (this.stopPromise !== undefined) return this.stopPromise
    if (this.currentStatus !== "running") {
      return
    }
    this.currentStatus = "stopped"
    this.stopPromise = this.stopRemote()
    return this.stopPromise
  }

  private async stopRemote(): Promise<void> {
    for (const commandHandle of this.inFlight) {
      commandHandle.kill("SIGKILL").catch(() => {})
    }
    this.inFlight.clear()
    try {
      await this.client.stop()
    } catch (error) {
      this.currentStatus = "failed"
      throw new SandboxError(`[Sandbox] vercel stop failed for ${this.id}: ${errorMessage(error)}`)
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return
    }

    if (this.currentStatus === "running") {
      try {
        await this.stop()
      } catch {
        // Deleting the sandbox is the real reclamation step; keep going if stop failed.
      }
    }

    try {
      await this.client.delete()
      this.destroyed = true
      this.currentStatus = "stopped"
    } catch (error) {
      throw new SandboxError(
        `[Sandbox] vercel delete failed for ${this.id}: ${errorMessage(error)}`
      )
    }
  }

  /**
   * Vercel ended this sandbox's session, at its time limit for one: nothing more runs in it, and a
   * persistent sandbox already saved its files as the session stopped. Its handle stops with it.
   */
  private sessionStopped(): SandboxNotRunningError {
    this.currentStatus = "stopped"
    this.inFlight.clear()
    return new SandboxNotRunningError(
      `[Sandbox] sandbox ${this.id} stopped: Vercel ended its session.`
    )
  }

  private assertRunning(action: string): void {
    const status = this.status
    if (status !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${status}; cannot ${action}`
      )
    }
  }

  private resolveWithinWorkingDirectory(path: string): string {
    const target = posix.resolve(this.workingDirectory, path)
    if (target !== this.workingDirectory && !target.startsWith(`${this.workingDirectory}/`)) {
      throw new Error(
        `[Sandbox] writeFiles path '${path}' escapes the sandbox working directory ${this.workingDirectory}`
      )
    }
    return target
  }
}

function normalizeWorkingDirectory(value: string | undefined): string {
  return value && value.length > 0 ? posix.resolve("/", value) : DEFAULT_WORKING_DIRECTORY
}

const GIVEN_UP = Symbol("given up")

/** Vercel's answer once a sandbox's session has ended: HTTP 410 with code `sandbox_stopped`. */
function isSessionStopped(error: unknown): boolean {
  if (!(error instanceof APIError) || error.response.status !== 410) return false
  const data: unknown = error.json
  const code =
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "object" &&
    data.error !== null &&
    "code" in data.error
      ? data.error.code
      : undefined
  return code === "sandbox_stopped"
}

function normalizeExitCode(exitCode: number | null | undefined, killed: boolean): number {
  if (typeof exitCode === "number") {
    return killed && exitCode === 0 ? KILLED_EXIT_CODE : exitCode
  }
  return killed ? KILLED_EXIT_CODE : 1
}

function abortedResult(start: number): CommandResult {
  return {
    exitCode: KILLED_EXIT_CODE,
    stdout: "",
    stderr: "[Sandbox] command aborted",
    durationMs: Date.now() - start,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
