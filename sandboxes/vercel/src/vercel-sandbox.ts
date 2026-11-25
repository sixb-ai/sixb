import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CommandResult,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  SandboxNotRunningError,
  type SandboxProcess,
  SandboxRequestRefusedError,
  type SandboxSessionOptions,
  type SandboxStatus,
} from "@sixb/core"
import { cappedCommandTimeout } from "@sixb/core/sandboxes"
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

/** Vercel's limit on a command's timeout: it refuses a longer one, before the command starts. */
export const VERCEL_MAX_COMMAND_TIMEOUT_MS = 5 * 60 * 60 * 1000

/** How often an open sandbox checks how long its session has left. */
export const KEEP_ALIVE_INTERVAL_MS = 60_000

/** A session with less than this left is extended. */
export const KEEP_ALIVE_MARGIN_MS = 5 * 60_000

/** How much one extension adds to a session. */
export const KEEP_ALIVE_EXTENSION_MS = 15 * 60_000

/**
 * A persistent sandbox nothing used for this long, with no command running, is no longer extended
 * until it is used again. It outlives its run, and a run its worker lost never stops it: it ends
 * with its session instead of running to the plan's maximum. The sub-agents a turn starts work in
 * the same sandbox, so a turn that waits for them still uses it.
 */
export const KEEP_ALIVE_IDLE_MS = 30 * 60_000

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
  /** When the session ends unless it is extended; read again after each extension. */
  readonly expiresAt?: Date
  /** Add `durationMs` to the session's lifetime, up to the plan's maximum. */
  readonly extendTimeout?: (durationMs: number) => Promise<void>
  /** The public URL of a port the sandbox was created with. Throws for any other port. */
  readonly domain?: (port: number) => string
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
  /**
   * Stop keeping the session alive once nothing used the sandbox for this long, until it is used
   * again: {@link KEEP_ALIVE_IDLE_MS} for a persistent sandbox. Absent, it is kept alive while
   * open, as an ephemeral sandbox, which its run always destroys.
   */
  readonly keepAliveIdleMs?: number
}

/**
 * Sandbox wrapper around a Vercel Sandbox SDK instance.
 *
 * While it is open, it keeps its session alive: a session with little time left is extended, up to
 * the plan's maximum, so it outlasts the turn that uses it. A persistent one left unused lets its
 * session end ({@link VercelSandboxOptions.keepAliveIdleMs}). Stop or destroy it when done. A
 * session Vercel ended stops the handle, and every later call fails at once.
 */
export class VercelSandbox implements Sandbox {
  readonly setRequestCredentials?: Sandbox["setRequestCredentials"]
  readonly credentialedUrl?: Sandbox["credentialedUrl"]
  readonly url?: Sandbox["url"]
  readonly id: string
  readonly provider = "vercel"
  readonly workingDirectory: string
  readonly maxCommandTimeout = VERCEL_MAX_COMMAND_TIMEOUT_MS

  private currentStatus: SandboxStatus = "running"
  private readonly client: VercelSandboxClient
  private readonly sandboxEnv: Readonly<Record<string, string>>
  private readonly defaultTimeoutMs: number | undefined
  private readonly keepAliveIdleMs: number | undefined
  private readonly inFlight = new Set<VercelCommandClient>()
  /** Commands {@link start} left running: the sandbox is in use while one serves. */
  private readonly serving = new Set<VercelCommandClient>()
  private destroyed = false
  private stopPromise: Promise<void> | undefined

  /**
   * Whether it keeps its session alive: `idle` once nothing used it for a while, until it is used
   * again; `off` for good, once it stopped or Vercel will not extend the session further.
   */
  private keepAliveState: "on" | "idle" | "off" = "off"
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined
  private extending: Promise<void> | undefined
  private lastUsedAt = Date.now()

  constructor(options: VercelSandboxOptions) {
    this.client = options.client
    this.id = options.id ?? options.client.name
    this.workingDirectory = normalizeWorkingDirectory(
      options.workingDirectory ?? options.client.cwd
    )
    this.sandboxEnv = options.env ?? {}
    this.defaultTimeoutMs = options.timeout
    this.keepAliveIdleMs = options.keepAliveIdleMs

    if (options.client.extendTimeout && options.client.expiresAt !== undefined) {
      this.startKeepAlive()
    }

    const { domain } = options.client
    if (domain) {
      this.url = (port) => {
        try {
          return domain.call(options.client, port)
        } catch {
          throw new SandboxError(
            `[Sandbox] port ${port} of ${this.id} is not public: create the sandbox with it in \`ports\`.`
          )
        }
      }
    }

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
    this.markUsed()

    const start = Date.now()
    const timeoutMs = cappedCommandTimeout(
      options.timeout ?? this.defaultTimeoutMs,
      this.maxCommandTimeout
    )
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
      // A refused start ran nothing, unlike a request that got no answer.
      const refused = refusal(error)
      if (refused) {
        throw new SandboxRequestRefusedError(
          `[Sandbox] Vercel refused the command (HTTP ${refused.status}${refused.code ? ` ${refused.code}` : ""})${refused.message ? `: ${refused.message}` : "."}`
        )
      }
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
      this.markUsed()
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

  /**
   * A detached command that outlives this call: it ends when it exits, is killed, or the session
   * stops. While it runs the sandbox counts as in use, so its session is kept alive.
   */
  readonly start = async (
    command: string,
    args: readonly string[] = [],
    options: Pick<RunCommandOptions, "cwd" | "env"> = {}
  ): Promise<SandboxProcess> => {
    this.assertRunning("start commands")
    this.markUsed()

    const marker = randomUUID()
    let handle: VercelCommandClient
    try {
      handle = await this.client.runCommand({
        cmd: command,
        args: [...args],
        cwd: posix.resolve(this.workingDirectory, options.cwd ?? "."),
        env: { ...this.sandboxEnv, ...(options.env ?? {}), [COMMAND_MARKER]: marker },
        detached: true,
      })
    } catch (error) {
      if (isSessionStopped(error)) throw this.sessionStopped()
      throw new SandboxError(
        `[Sandbox] vercel could not start a command in ${this.id}: ${errorMessage(error)}`
      )
    }

    this.serving.add(handle)
    const exited = handle.wait().then(
      (finished) => normalizeExitCode(finished.exitCode, false),
      () => KILLED_EXIT_CODE
    )
    void exited.then(() => this.serving.delete(handle))

    let killing: Promise<void> | undefined
    return {
      exited,
      kill: () => {
        // Its own process, then whatever it started, as a killed command's are.
        killing ??= handle
          .kill("SIGKILL")
          .catch(() => {})
          .then(() => this.killMarkedProcesses(marker))
        return killing
      },
    }
  }

  /** Makes sure the session lasts at least `ms` more, extending it when it would end sooner. */
  readonly keepAlive = async (ms: number): Promise<void> => {
    this.assertRunning("extend its session")
    this.markUsed()

    const { expiresAt, extendTimeout } = this.client
    if (!extendTimeout || !expiresAt) return
    const missing = Date.now() + ms - expiresAt.getTime()
    if (missing <= 0) return

    try {
      await extendTimeout.call(this.client, missing)
    } catch (error) {
      if (isSessionStopped(error)) throw this.sessionStopped()
      throw new SandboxError(
        `[Sandbox] vercel could not extend the session of ${this.id}: ${errorMessage(error)}`
      )
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
    this.markUsed()

    try {
      await this.client.writeFiles(mapped)
    } catch (error) {
      if (isSessionStopped(error)) throw this.sessionStopped()
      throw new SandboxError(
        `[Sandbox] vercel writeFiles failed for ${this.id}: ${errorMessage(error)}`
      )
    } finally {
      this.markUsed()
    }
  }

  async stop(): Promise<void> {
    // Concurrent/repeated callers must await the same confirmed outcome, including failure.
    if (this.stopPromise !== undefined) return this.stopPromise
    if (this.currentStatus !== "running") {
      return
    }
    this.currentStatus = "stopped"
    this.stopKeepAlive()
    this.stopPromise = this.stopRemote()
    return this.stopPromise
  }

  private async stopRemote(): Promise<void> {
    for (const commandHandle of [...this.inFlight, ...this.serving]) {
      commandHandle.kill("SIGKILL").catch(() => {})
    }
    this.inFlight.clear()
    this.serving.clear()
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
    this.stopKeepAlive()

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
    this.stopKeepAlive()
    this.inFlight.clear()
    this.serving.clear()
    return new SandboxNotRunningError(
      `[Sandbox] sandbox ${this.id} stopped: Vercel ended its session.`
    )
  }

  /** It was used just now: an idle keepalive starts again, and checks the session at once. */
  private markUsed(): void {
    this.lastUsedAt = Date.now()
    if (this.keepAliveState === "idle" && this.currentStatus === "running") this.startKeepAlive()

    void this.extendSession()
  }

  /**
   * Extend the session once little of it is left. Never throws: a session Vercel ended stops this
   * handle, so the next call fails at once instead of reaching Vercel; one Vercel will not extend
   * further, at the plan's maximum for one, ends when it says.
   */
  private extendSession(): Promise<void> {
    if (this.extending) return this.extending
    if (this.keepAliveState !== "on" || this.currentStatus !== "running") return Promise.resolve()

    const idle =
      this.keepAliveIdleMs !== undefined &&
      this.inFlight.size === 0 &&
      this.serving.size === 0 &&
      Date.now() - this.lastUsedAt >= this.keepAliveIdleMs
    if (idle) {
      this.pauseKeepAlive()
      return Promise.resolve()
    }

    const { expiresAt, extendTimeout } = this.client
    if (!extendTimeout || !expiresAt || expiresAt.getTime() - Date.now() > KEEP_ALIVE_MARGIN_MS) {
      return Promise.resolve()
    }

    this.extending = extendTimeout
      .call(this.client, KEEP_ALIVE_EXTENSION_MS)
      .catch((error: unknown) => this.extensionFailed(error, expiresAt))
      .finally(() => {
        this.extending = undefined
      })
    return this.extending
  }

  /**
   * A session Vercel ended stops the handle. One it will not extend further is left to end; a
   * failure that may pass, a 5xx, a 429 or no answer, is tried again at the next check.
   */
  private extensionFailed(error: unknown, expiresAt: Date): void {
    if (isSessionStopped(error)) {
      this.sessionStopped()
      return
    }

    const refused = refusal(error)
    if (refused) {
      this.stopKeepAlive()
      console.warn(
        `[Sandbox] Vercel would not extend the session of ${this.id} (HTTP ${refused.status}${refused.code ? ` ${refused.code}` : ""}); it ends at ${expiresAt.toISOString()}.`
      )
      return
    }

    console.warn(
      `[Sandbox] The session of ${this.id} could not be extended; trying again in ${KEEP_ALIVE_INTERVAL_MS / 1000} s. ${errorMessage(error)}`
    )
  }

  /** Never holds the process open: a worker that exits stops extending, and the session ends. */
  private startKeepAlive(): void {
    this.keepAliveState = "on"
    this.keepAliveTimer = setInterval(() => void this.extendSession(), KEEP_ALIVE_INTERVAL_MS)
    this.keepAliveTimer.unref?.()
  }

  private pauseKeepAlive(): void {
    this.clearKeepAliveTimer()
    this.keepAliveState = "idle"
  }

  private stopKeepAlive(): void {
    this.clearKeepAliveTimer()
    this.keepAliveState = "off"
  }

  private clearKeepAliveTimer(): void {
    if (this.keepAliveTimer !== undefined) clearInterval(this.keepAliveTimer)
    this.keepAliveTimer = undefined
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
      throw new SandboxRequestRefusedError(
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

/** The longest part of Vercel's own reason for a refusal that an error message keeps. */
const REFUSAL_MESSAGE_CHARS = 500

/** Vercel's answer once a sandbox's session has ended: HTTP 410 with code `sandbox_stopped`. */
function isSessionStopped(error: unknown): boolean {
  return (
    error instanceof APIError &&
    error.response.status === 410 &&
    apiErrorBody(error).code === "sandbox_stopped"
  )
}

/**
 * A request Vercel answered with a refusal: a 4xx status, before it did anything.
 *
 * Two are not refusals. A 408, as the request may have reached the sandbox before it timed out. A
 * 429, as it answers the moment, not the request: the SDK retries a 5xx or a dropped connection, so
 * the 429 that ends those retries says nothing of an earlier attempt that may have run. Any other
 * 4xx answers the request itself, which an earlier attempt sent unchanged.
 */
function refusal(
  error: unknown
): { readonly status: number; readonly code?: string; readonly message?: string } | undefined {
  if (!(error instanceof APIError)) return undefined
  const { status } = error.response
  if (status < 400 || status >= 500 || status === 408 || status === 429) return undefined
  const { code, message } = apiErrorBody(error)
  return {
    status,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message: message.slice(0, REFUSAL_MESSAGE_CHARS) }),
  }
}

/** The `{ error: { code, message } }` Vercel answers an error with. */
function apiErrorBody(error: APIError<unknown>): {
  readonly code?: string
  readonly message?: string
} {
  const data: unknown = error.json
  if (typeof data !== "object" || data === null || !("error" in data)) return {}
  const body: unknown = data.error
  if (typeof body !== "object" || body === null) return {}
  const code = "code" in body && typeof body.code === "string" ? body.code : undefined
  const message = "message" in body && typeof body.message === "string" ? body.message : undefined
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  }
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
