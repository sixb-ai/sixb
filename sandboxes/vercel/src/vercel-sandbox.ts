import { posix } from "node:path"
import {
  type CommandResult,
  type CreateSandboxOptions,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  SandboxNotRunningError,
  type SandboxStatus,
} from "@sixb/core"

const DEFAULT_WORKING_DIRECTORY = "/vercel/sandbox"
const KILLED_EXIT_CODE = 137

export interface VercelRunCommandParams {
  readonly cmd: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly detached?: false
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
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

    try {
      // Use the SDK's awaited path. It returns stdout/stderr with the command response, including
      // the valid empty-output case. The detached path requires a later logs request, which can
      // fail when a command produced no log stream.
      const commandHandle = await this.client.runCommand({
        cmd: command,
        args: [...args],
        cwd,
        env,
        detached: false,
        ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeoutMs } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const finished = await commandHandle.wait({ signal: options.signal })
      const [stdout, stderr] = await Promise.all([
        finished.stdout({ signal: options.signal }),
        finished.stderr({ signal: options.signal }),
      ])
      if (options.signal?.aborted) {
        return abortedResult(start)
      }
      const exitCode = normalizeExitCode(finished.exitCode)
      const timedOut = timeoutMs !== undefined && timeoutMs > 0 && exitCode === KILLED_EXIT_CODE
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - start,
        ...(timedOut ? { timedOut: true } : {}),
      }
    } catch (error) {
      if (options.signal?.aborted) {
        return abortedResult(start)
      }
      throw new SandboxError(
        `[Sandbox] vercel command failed for ${this.id}: ${errorMessage(error)}`
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

    try {
      await this.client.writeFiles(mapped)
    } catch (error) {
      throw new SandboxError(
        `[Sandbox] vercel writeFiles failed for ${this.id}: ${errorMessage(error)}`
      )
    }
  }

  async stop(): Promise<void> {
    if (this.currentStatus !== "running") {
      return
    }
    this.currentStatus = "stopped"
    try {
      await this.client.stop()
    } catch (error) {
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

function normalizeExitCode(exitCode: number | null | undefined): number {
  return typeof exitCode === "number" ? exitCode : 1
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
