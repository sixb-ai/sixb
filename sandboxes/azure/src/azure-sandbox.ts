import {
  type CommandResult,
  type RunCommandOptions,
  type Sandbox,
  SandboxError,
  type SandboxFileRecord,
  SandboxNotRunningError,
  type SandboxSessionOptions,
  type SandboxStatus,
} from "@sixb/core/sandboxes"
import type { AzureSandboxClient } from "./azure-client"
import { AzureCommandExecution, resolveCommand } from "./command-execution"
import { AzureFilePolicyError, materializeFiles, prepareFiles } from "./file-materialization"
import { type AzureLifecycleOptions, deleteAzureSandbox, stopAzureSandbox } from "./lifecycle"

/** Internal session handle. A closed handle can never attach to a later session. */
export class AzureSandbox implements Sandbox {
  readonly provider = "azure"
  readonly workingDirectory: string
  private currentStatus: SandboxStatus = "running"
  private stopPromise: Promise<void> | undefined
  private readonly closing = new AbortController()
  private readonly inFlight = new Set<Promise<unknown>>()
  private filesTail: Promise<void> = Promise.resolve()
  private reclamationPromise: Promise<void> | undefined
  private destroyPromise: Promise<void> | undefined

  constructor(
    readonly id: string,
    private readonly client: AzureSandboxClient,
    /** Current execution defaults; never recovered from the guest or sent as VM environment. */
    readonly executionDefaults: SandboxSessionOptions & { readonly workingDirectory: string },
    private readonly lifecycle: AzureLifecycleOptions,
    private readonly supervisorRoot?: string
  ) {
    this.workingDirectory = executionDefaults.workingDirectory
  }

  /** Last confirmed/session-local status. Closing a handle rejects work immediately. */
  get status(): SandboxStatus {
    return this.currentStatus
  }

  async runCommand(
    command: string,
    args: readonly string[] = [],
    options: RunCommandOptions = {}
  ): Promise<CommandResult> {
    this.assertRunning("run commands")
    const input = resolveCommand(this.executionDefaults, command, args, options)
    if (!this.supervisorRoot) throw new SandboxError("[Sandbox] Azure supervisor is not installed.")
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.closing.signal])
      : this.closing.signal
    const execution = new AzureCommandExecution(
      this.client,
      this.id,
      this.supervisorRoot,
      this.lifecycle.teardownTimeoutMs
    )
    const pending = execution
      .run(input, signal)
      .catch((error: unknown) => this.failAndReclaim("command", error))
    this.inFlight.add(pending)
    try {
      return await pending
    } finally {
      this.inFlight.delete(pending)
    }
  }

  async writeFiles(files: readonly SandboxFileRecord[]): Promise<void> {
    this.assertRunning("write files")
    const prepared = prepareFiles(this.workingDirectory, files)
    if (prepared.length === 0) return
    const root = this.supervisorRoot
    if (!root) throw new SandboxError("[Sandbox] Azure supervisor is not installed.")
    const pending = this.filesTail.then(async () => {
      this.assertRunning("write files")
      try {
        await materializeFiles(this.client, this.id, root, prepared, this.closing.signal)
      } catch (error) {
        if (error instanceof AzureFilePolicyError) throw error
        return this.failAndReclaim("file materialization", error)
      }
    })
    // Serialize publication across callers. A rejected path must not poison the queue.
    this.filesTail = pending.catch(() => {})
    this.inFlight.add(pending)
    try {
      await pending
    } finally {
      this.inFlight.delete(pending)
    }
  }

  private async failAndReclaim(operation: string, error: unknown): Promise<never> {
    // An uncertain remote operation cannot leave a reusable session behind.
    this.currentStatus = "failed"
    this.closing.abort()
    try {
      await this.reclaim()
    } catch {
      throw new SandboxError(
        `[Sandbox] Azure ${operation} failed and sandbox ${this.id} deletion could not be confirmed; inspect and reclaim it.`
      )
    }
    const detail =
      error instanceof SandboxError ? error.message : `[Sandbox] Azure ${operation} failed.`
    throw new SandboxError(`${detail} The sandbox was reclaimed.`)
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (this.destroyPromise) return this.destroyPromise
    this.currentStatus = "stopped"
    this.closing.abort()
    this.stopPromise = this.stopRemote().catch((error) => {
      this.currentStatus = "failed"
      throw error
    })
    return this.stopPromise
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.currentStatus = "stopped"
    this.closing.abort()
    this.destroyPromise = this.destroyRemote()
    return this.destroyPromise
  }

  private async stopRemote(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
    if (this.reclamationPromise) await this.reclamationPromise
    else await stopAzureSandbox(this.client, this.id, this.lifecycle)
    this.currentStatus = "stopped"
  }

  private reclaim(): Promise<void> {
    this.reclamationPromise ??= deleteAzureSandbox(this.client, this.id, this.lifecycle)
    return this.reclamationPromise
  }

  private async destroyRemote(): Promise<void> {
    if (this.stopPromise) {
      try {
        await this.stopPromise
      } catch {
        // Stop failure must not prevent reclamation. Delete has its own confirmation/deadline.
      }
    }
    try {
      await Promise.allSettled([...this.inFlight])
      await this.reclaim()
      this.currentStatus = "stopped"
    } catch (error) {
      this.currentStatus = "failed"
      throw error
    }
  }

  private assertRunning(action: string): void {
    if (this.currentStatus !== "running") {
      throw new SandboxNotRunningError(
        `[Sandbox] Azure sandbox ${this.id} is ${this.currentStatus}; cannot ${action}.`
      )
    }
  }
}
