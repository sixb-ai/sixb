import { randomUUID } from "node:crypto"
import { posix } from "node:path"
import {
  type CommandResult,
  GUEST_CREDENTIAL_PATHS,
  GUEST_FORWARDER_NOT_RUNNING,
  guestCredentialedUrl,
  guestCredentialsCommands,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  type SandboxNetworkPolicy,
  SandboxNotRunningError,
  type SandboxRequestCredential,
  type SandboxStatus,
} from "@sixb/core/sandboxes"
import { type BoxdClient, type BoxdCommandStream, isNotFound } from "./boxd-client"
import {
  assertGuestEnv,
  detachedRootCommand,
  GUEST_PATHS,
  placeCredentialsCommand,
  placeFilesCommand,
  rootCommand,
  unprivilegedCommand,
} from "./guest"
import { assertCredentialsAllowed, NO_EGRESS } from "./network"

const KILLED_EXIT_CODE = 137
const HIBERNATE_POLL_MS = 250

/** A bound for the provider's own steps in the guest, such as installing credentials. */
export const DEFAULT_SETUP_TIMEOUT_MS = 60_000

export interface BoxdSandboxOptions {
  readonly client: BoxdClient
  readonly machineId: string
  readonly machineName: string
  /** Named state: stop() keeps the machine for resume and destroy() deletes it. */
  readonly persistent: boolean
  readonly workingDirectory: string
  readonly env: Readonly<Record<string, string>>
  readonly timeout: number | undefined
  readonly network: SandboxNetworkPolicy
  readonly setupTimeoutMs: number
}

/** A boxd machine as a Sixb sandbox. Every operation targets the machine by its id. */
export class BoxdSandbox implements Sandbox {
  readonly id: string
  readonly provider = "boxd"
  readonly workingDirectory: string
  /** The machine's name, which is what a persistent sandbox resumes by. */
  readonly machineName: string

  private currentStatus: SandboxStatus = "running"
  private readonly client: BoxdClient
  private readonly persistent: boolean
  private readonly sandboxEnv: Readonly<Record<string, string>>
  private readonly defaultTimeoutMs: number | undefined
  private readonly network: SandboxNetworkPolicy
  private readonly setupTimeoutMs: number
  private readonly inFlight = new Set<BoxdCommandStream>()
  private credentialsInstalled = false
  private stopPromise: Promise<void> | undefined
  private destroyPromise: Promise<void> | undefined

  constructor(options: BoxdSandboxOptions) {
    assertGuestEnv(options.env)
    this.client = options.client
    this.id = options.machineId
    this.machineName = options.machineName
    this.persistent = options.persistent
    this.workingDirectory = options.workingDirectory
    this.sandboxEnv = options.env
    this.defaultTimeoutMs = options.timeout
    this.network = options.network
    this.setupTimeoutMs = options.setupTimeoutMs
  }

  get status(): SandboxStatus {
    return this.currentStatus
  }

  /**
   * Replace the credentials the guest's forwarder adds; an empty list removes them. Commands reach
   * an origin with its credential at {@link credentialedUrl}.
   */
  readonly setRequestCredentials = async (
    credentials: readonly SandboxRequestCredential[]
  ): Promise<void> => {
    this.assertRunning("update request credentials")
    assertCredentialsAllowed(this.network, credentials)
    await this.installCredentials(credentials)
  }

  /**
   * A socket in the guest that forwards to `url` with the matching credential. A root forwarder
   * holds the credentials; commands run unprivileged and cannot read them.
   */
  readonly credentialedUrl = (url: string): string => guestCredentialedUrl(url)

  /** Every command runs as an unprivileged user, so it cannot read what the guest's root holds. */
  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.assertRunning("run commands")
    const env = { ...this.sandboxEnv, ...(options.env ?? {}) }
    assertGuestEnv(env)
    const cwd = posix.resolve(this.workingDirectory, options.cwd ?? ".")
    const timeoutMs = options.timeout ?? this.defaultTimeoutMs
    return this.collect(unprivilegedCommand(cwd, env, command, args), timeoutMs, options.signal)
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    this.assertRunning("write files")
    if (files.length === 0) return

    // Upload each file's bytes to a staging path, then copy them into place as the command user.
    const staged = files.map((file) => ({
      staged: `${GUEST_PATHS.files}/${randomUUID()}`,
      path: posix.resolve(this.workingDirectory, file.path),
      contents: file.contents,
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    }))
    try {
      for (const file of staged) {
        await this.client.upload(this.id, file.staged, file.contents)
      }
    } catch (error) {
      throw new SandboxError(
        `[Sandbox] boxd writeFiles failed for ${this.id}: ${errorMessage(error)}`
      )
    }
    const result = await this.collect(placeFilesCommand(staged), this.setupTimeoutMs)
    if (result.exitCode !== 0) {
      throw new SandboxError(
        `[Sandbox] boxd writeFiles failed for ${this.id}: ${result.stderr.trim() || `exit ${result.exitCode}`}`
      )
    }
  }

  /**
   * Stop this session. The machine hibernates, keeping its disk and memory. A persistent one first
   * loses its credentials and its egress, so nothing of this run's authority waits for the next.
   * Repeated and concurrent calls share the outcome, failure included.
   */
  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    if (this.currentStatus !== "running") return
    this.currentStatus = "stopped"
    for (const stream of this.inFlight) stream.close()
    this.inFlight.clear()
    this.stopPromise = this.stopRemote()
    return this.stopPromise
  }

  /** Stop, then delete the machine, named state included. Idempotent. */
  async destroy(): Promise<void> {
    this.destroyPromise ??= this.destroyRemote()
    return this.destroyPromise
  }

  /** Run one of the provider's own command lines as the machine's default user. */
  runSetup(commandLine: string): Promise<CommandResult> {
    this.assertRunning("run setup")
    return this.collect(commandLine, this.setupTimeoutMs)
  }

  /** Install credentials during creation or resume, before any setup command runs. */
  async installCredentials(credentials: readonly SandboxRequestCredential[]): Promise<void> {
    const commands = guestCredentialsCommands(credentials)
    // Never the output or the SDK's error: a failed step must not echo what it was given.
    const failed = () =>
      new SandboxError(`[Sandbox] boxd could not install request credentials in ${this.id}.`)

    const files = commands.files.map((file) => ({
      ...file,
      staged: `${GUEST_PATHS.staging}/${randomUUID()}`,
    }))
    try {
      for (const file of files) {
        await this.client.upload(this.id, file.staged, file.contents)
      }
    } catch {
      throw failed()
    }
    const placed = await this.collect(
      placeCredentialsCommand(GUEST_CREDENTIAL_PATHS.state, files),
      this.setupTimeoutMs
    )
    if (placed.exitCode !== 0) throw failed()

    const installed = await this.collect(
      rootCommand(commands.install, commands.fileEnv),
      this.setupTimeoutMs
    )
    if (installed.exitCode === 3) {
      throw new SandboxError(
        `[Sandbox] boxd request credentials need Bun or Node on the machine ${this.id}.`
      )
    }
    if (installed.exitCode === GUEST_FORWARDER_NOT_RUNNING) {
      const started = await this.collect(detachedRootCommand(commands.start), this.setupTimeoutMs)
      if (started.exitCode !== 0) throw failed()
    } else if (installed.exitCode !== 0) {
      throw failed()
    }
    if ((await this.collect(rootCommand(commands.ready), this.setupTimeoutMs)).exitCode !== 0) {
      throw failed()
    }
    this.credentialsInstalled = credentials.length > 0
  }

  private async stopRemote(): Promise<void> {
    let cleanupFailed = false
    if (this.persistent) {
      try {
        if (this.credentialsInstalled) await this.installCredentials([])
        await this.client.setEgress(this.id, NO_EGRESS)
      } catch {
        cleanupFailed = true
      }
    }
    try {
      // Hibernating even when cleanup failed: a run's machine must not stay up.
      await this.client.hibernate(this.id)
      await this.confirmHibernated()
    } catch (error) {
      this.currentStatus = "failed"
      throw new SandboxError(
        `[Sandbox] boxd could not hibernate ${this.id}: ${errorMessage(error)}`
      )
    }
    if (cleanupFailed) {
      this.currentStatus = "failed"
      throw new SandboxError(
        `[Sandbox] boxd hibernated ${this.id} but could not remove its credentials and egress first.`
      )
    }
  }

  /** Stop returns once boxd reports the machine hibernated, so a resume can follow at once. */
  private async confirmHibernated(): Promise<void> {
    const deadline = Date.now() + this.setupTimeoutMs
    for (;;) {
      const { status } = await this.client.get(this.id)
      if (status === "hibernated" || status === "stopped") return
      if (Date.now() >= deadline) {
        throw new Error(`still ${status} after ${this.setupTimeoutMs} ms`)
      }
      await Bun.sleep(HIBERNATE_POLL_MS)
    }
  }

  private async destroyRemote(): Promise<void> {
    if (this.currentStatus === "running") {
      // Deleting the machine is what reclaims it; carry on when hibernating fails.
      await this.stop().catch(() => {})
    }
    this.currentStatus = "stopped"
    try {
      await this.client.delete(this.id)
    } catch (error) {
      if (isNotFound(error)) return
      this.destroyPromise = undefined
      throw new SandboxError(`[Sandbox] boxd could not delete ${this.id}: ${errorMessage(error)}`)
    }
  }

  /** Run a command line and gather its output, killing it at `timeoutMs` or on `signal`. */
  private async collect(
    commandLine: string,
    timeoutMs: number | undefined,
    signal?: AbortSignal
  ): Promise<CommandResult> {
    const start = Date.now()
    if (signal?.aborted) return killedResult(start, "", "", false)

    const stream = this.client.exec(this.id, commandLine)
    this.inFlight.add(stream)
    const stdout = drain(stream.stdout)
    const stderr = drain(stream.stderr)

    let timedOut = false
    let killed = false
    const kill = (): void => {
      if (killed) return
      killed = true
      stream.close()
    }
    const timer =
      timeoutMs !== undefined && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            kill()
          }, timeoutMs)
        : undefined
    signal?.addEventListener("abort", kill)

    try {
      const exitCode = await stream.wait()
      return {
        exitCode: killed && exitCode === 0 ? KILLED_EXIT_CODE : exitCode,
        stdout: await stdout,
        stderr: await stderr,
        durationMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
      }
    } catch (error) {
      if (killed) {
        return killedResult(start, await stdout, await stderr, timedOut)
      }
      throw new SandboxError(`[Sandbox] boxd command failed on ${this.id}: ${errorMessage(error)}`)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", kill)
      this.inFlight.delete(stream)
    }
  }

  private assertRunning(action: string): void {
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] sandbox ${this.id} is ${this.currentStatus}; cannot ${action}`
      )
    }
  }
}

/** Read a stream to its end as UTF-8, keeping what arrived if it ends with an error. */
async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  try {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true })
  } catch {
    // A killed command's stream ends with the cancellation: what arrived before it stands.
  }
  return text + decoder.decode()
}

function killedResult(
  start: number,
  stdout: string,
  stderr: string,
  timedOut: boolean
): CommandResult {
  return {
    exitCode: KILLED_EXIT_CODE,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    ...(timedOut ? { timedOut: true } : {}),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
