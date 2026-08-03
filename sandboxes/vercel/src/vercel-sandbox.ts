import { posix } from "node:path"
import type {
  CommandResult,
  CreateSandboxOptions,
  RunCommandOptions,
  Sandbox,
  SandboxFileRecord,
  SandboxStatus,
} from "@sixb/core"
import { SixbError } from "@sixb/core/errors"

const DEFAULT_WORKING_DIRECTORY = "/vercel/sandbox"
const KILLED_EXIT_CODE = 137

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
  kill(signal?: string, opts?: { readonly abortSignal?: AbortSignal }): Promise<void>
}

export interface VercelSandboxClient {
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

export interface VercelSandboxOptions extends CreateSandboxOptions {
  readonly id?: string
  readonly client: VercelSandboxClient
}

/** Sandbox wrapper around a Vercel Sandbox SDK instance. */
export class VercelSandbox implements Sandbox {
  readonly id: string
  readonly provider = "vercel"
  readonly workingDirectory: string

  private currentStatus: SandboxStatus = "running"
  private readonly client: VercelSandboxClient
  private readonly sandboxEnv: Readonly<Record<string, string>>
  private readonly defaultTimeoutMs: number | undefined
  private readonly inFlight = new Set<VercelCommandClient>()
  private destroyed = false

  constructor(options: VercelSandboxOptions) {
    this.client = options.client
    this.id = options.id ?? options.client.name
    this.workingDirectory = normalizeWorkingDirectory(
      options.workingDirectory ?? options.client.cwd
    )
    this.sandboxEnv = options.env ?? {}
    this.defaultTimeoutMs = options.timeout
  }

  get status(): SandboxStatus {
    if (this.currentStatus !== "running") {
      return this.currentStatus
    }
    if (this.client.status === "failed") {
      return "failed"
    }
    if (this.client.status === "stopped") {
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
    const cwd = options.cwd ?? this.workingDirectory

    if (options.signal?.aborted) {
      return abortedResult(start)
    }

    let timedOut = false
    let aborted = false
    let killStarted = false
    let commandHandle: VercelCommandClient

    try {
      commandHandle = await this.client.runCommand({
        cmd: command,
        args: [...args],
        cwd,
        env,
        detached: true,
        ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
      })
    } catch (error) {
      throw new SixbError(
        "sandbox.failed",
        `[Sandbox] vercel runCommand failed for ${this.id}: ${errorMessage(error)}`
      )
    }

    this.inFlight.add(commandHandle)

    const kill = (): void => {
      if (killStarted) {
        return
      }
      killStarted = true
      commandHandle.kill("SIGKILL").catch(() => {})
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
      kill()
    }
    options.signal?.addEventListener("abort", onAbort)
    if (options.signal?.aborted) {
      onAbort()
    }

    try {
      const finished = await commandHandle.wait()
      const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()])
      const exitCode = normalizeExitCode(finished.exitCode, killStarted)
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
      }
    } catch (error) {
      if (timedOut || aborted) {
        return {
          exitCode: KILLED_EXIT_CODE,
          stdout: "",
          stderr: timedOut
            ? `[Sandbox] command timed out after ${timeoutMs}ms`
            : "[Sandbox] command aborted",
          durationMs: Date.now() - start,
          ...(timedOut ? { timedOut: true } : {}),
        }
      }
      throw new SixbError(
        "sandbox.failed",
        `[Sandbox] vercel command failed for ${this.id}: ${errorMessage(error)}`
      )
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      options.signal?.removeEventListener("abort", onAbort)
      this.inFlight.delete(commandHandle)
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
      throw new SixbError(
        "sandbox.failed",
        `[Sandbox] vercel writeFiles failed for ${this.id}: ${errorMessage(error)}`
      )
    }
  }

  async stop(): Promise<void> {
    if (this.currentStatus !== "running") {
      return
    }
    this.currentStatus = "stopped"
    for (const commandHandle of this.inFlight) {
      commandHandle.kill("SIGKILL").catch(() => {})
    }
    this.inFlight.clear()
    try {
      await this.client.stop()
    } catch (error) {
      throw new SixbError(
        "sandbox.failed",
        `[Sandbox] vercel stop failed for ${this.id}: ${errorMessage(error)}`
      )
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
      throw new SixbError(
        "sandbox.failed",
        `[Sandbox] vercel delete failed for ${this.id}: ${errorMessage(error)}`
      )
    }
  }

  private assertRunning(action: string): void {
    const status = this.status
    if (status !== "running") {
      throw new SixbError(
        "sandbox.not_running",
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
