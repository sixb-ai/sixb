import { createHash } from "node:crypto"
import {
  type AcquiredRunSandbox,
  AgentEnvironmentSaveError,
  type BeforeFinalizeOptions,
  type RunSandbox,
  SANDBOX_CONTEXT_DIRECTORY,
  waitForAbort,
} from "@sixb/agent"
import type {
  Sandbox,
  SandboxDefinition,
  SandboxEnvironment,
  SandboxFactory,
  SandboxRequestCredential,
} from "@sixb/core"
import {
  AgentExecutionLostError,
  type AgentRunSession,
  createAgentThreadSandboxName,
} from "@sixb/core/internal/agents"
import { SandboxStateUnavailableError, sandboxProjectDirectory } from "@sixb/core/sandboxes"
import type {
  AgentThreadRecord,
  ConversationAgentRunRecord,
  SubagentRunRecord,
} from "@sixb/core/storage"
import { bounded, sandboxError } from "./sandbox-operation"
import type { AgentRunnerContext } from "./types"
import { WorkspaceAccess } from "./workspace-access"
import { prepareWorkspaceRunFiles, WorkspaceRunFilesConflictError } from "./workspace-files"

interface PersistentRunSandboxInput {
  readonly context: AgentRunnerContext
  /** The run's session: the thread's workspace state moves only through it. */
  readonly session: AgentRunSession
  /** A conversation's recipe. A sub-agent's thread has none: its workspace is blank. */
  readonly definition?: SandboxDefinition
  readonly thread: AgentThreadRecord
  readonly run: ConversationAgentRunRecord | SubagentRunRecord
  readonly signal: AbortSignal
  /** The run's credential for the Sixb API, added when the factory adds credentials. */
  readonly apiCredential: SandboxRequestCredential
  readonly onAuthFailure: (error: Error) => void
}

/** A thread's workspace, as one run opened it. */
export interface PersistentRunSandbox extends RunSandbox {
  /**
   * Whether the run found the workspace its thread's last run saved. False when it was created,
   * for the thread's first run or because the saved files were lost.
   */
  readonly resumed: boolean
}

/**
 * A thread's workspace, kept across its runs: created by the first run, resumed by each later one,
 * and saved before every run's terminal write. A conversation's is prepared from the resolved
 * recipe and never destroyed. A sub-agent's is blank, kept while it pauses, and destroyed by a run
 * that ends without pausing.
 *
 * Resolve current authority before taking any provider action; never trust guest metadata.
 */
export async function persistentRunSandbox(
  input: PersistentRunSandboxInput
): Promise<PersistentRunSandbox> {
  const { context, signal } = input
  const factory = context.sandboxes
  if (typeof factory.resume !== "function") {
    throw sandboxError("requires a configured recipe and persistent sandbox provider.")
  }
  const recipe = await resolveRecipe(input)
  signal.throwIfAborted()
  const session = new PersistentSandboxSession(input, recipe, factory.resume.bind(factory))

  // A sub-agent's first run creates a blank workspace its prompt says nothing about: it boots
  // while the model starts, as an ephemeral sandbox does.
  const { thread } = input
  return thread.kind === "subagent" && !thread.sandboxState ? session.openLazily() : session.open()
}

/** Whether a sub-agent's workspace is kept while it pauses: only on a provider that resumes. */
export function keepsSubagentWorkspace(factory: SandboxFactory): boolean {
  return typeof factory.resume === "function"
}

async function resolveRecipe(input: PersistentRunSandboxInput): Promise<SandboxEnvironment> {
  const { context, definition, thread, signal } = input
  // No source, setup or env, and only the Sixb API on the network: an ephemeral child's sandbox.
  if (thread.kind === "subagent") return {}

  if (!definition || !thread.sandboxParams) {
    throw sandboxError("requires a configured recipe and persistent sandbox provider.")
  }
  return structuredClone(
    await waitForAbort(
      bounded(definition.resolve({ params: thread.sandboxParams, sixb: context.sixb })),
      signal
    )
  )
}

/** One execution owns acquisition, guarded operations and preservation of its provider session. */
class PersistentSandboxSession {
  private readonly access: WorkspaceAccess
  private readonly sourceFingerprint: string
  private name: string
  private initialized = false
  private resumed = false
  private resetAt: string | undefined
  private readonly pending = new Set<Promise<unknown>>()
  private saving: Promise<void> | undefined
  private closed = false
  private uncertainOperation = false

  constructor(
    private readonly input: PersistentRunSandboxInput,
    private readonly recipe: SandboxEnvironment,
    private readonly resume: NonNullable<SandboxFactory["resume"]>
  ) {
    const { context, definition, thread, signal, onAuthFailure } = input
    this.access = new WorkspaceAccess({
      recipe,
      auth: definition?.auth,
      factory: context.sandboxes,
      apiOrigin: new URL(context.apiBaseUrl).origin,
      apiCredential: input.apiCredential,
      signal,
      assertOwner: () => this.assertOwner(),
      onAuthFailure,
    })
    // Compare recipe identity, not the mutable branch/remote in the guest.
    this.sourceFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          url: this.access.sourceUrl?.href ?? null,
          revision: recipe.source?.revision ?? null,
        })
      )
      .digest("hex")
    // A sub-agent's workspace that its last run left unsaved, destroyed or in doubt starts again
    // under a new name, from its handed files and out/: nobody could recreate it.
    const state = thread.sandboxState
    const reusable =
      state && (thread.kind !== "subagent" || state.status === "new" || state.status === "ready")
    this.name = reusable ? state.name : createAgentThreadSandboxName(context.id, thread.id)
    if (
      thread.sandboxState?.sourceFingerprint &&
      thread.sandboxState.sourceFingerprint !== this.sourceFingerprint
    ) {
      throw sandboxError(
        "source identity changed. Restore the configured repository and initial revision to resume this checkout."
      )
    }
  }

  async open(): Promise<PersistentRunSandbox> {
    await this.access.authorize()
    await this.acquireOwnership()
    let session: Sandbox | undefined
    try {
      const acquired = await this.createOrResume()
      session = this.initialized
        ? sandboxProjectDirectory(acquired, this.recipe.source !== undefined)
        : acquired
      await this.assertCanContinue()
      this.access.attach(session)
      this.initialized = true
      await prepareWorkspaceRunFiles(session, this.recipe.source !== undefined)
      await this.assertCanContinue()
    } catch (error) {
      await this.quarantineAcquisition(error, session)
      throw acquisitionError(error)
    }
    return this.runSandbox(session)
  }

  /** Open on the first `acquire()`, without the run waiting for it before its first model call. */
  openLazily(): PersistentRunSandbox {
    let opened: Promise<PersistentRunSandbox> | undefined
    let finalized = false

    return {
      waitBeforeModel: false,
      contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
      resumed: false,
      acquire: () => {
        if (finalized) return Promise.reject(sandboxError("is being saved."))
        opened ??= this.open()
        return opened.then((sandbox) => sandbox.acquire())
      },
      beforeFinalize: async (options) => {
        finalized = true
        // Nothing to keep before it opened, nor once its opening failed: that quarantined it.
        const sandbox = await opened?.catch(() => undefined)
        await sandbox?.beforeFinalize?.(options)
      },
    }
  }

  private async acquireOwnership(): Promise<void> {
    const { session, thread } = this.input
    try {
      const state = await session.workspace.transition({
        id: thread.id,
        action: "acquire",
        name: this.name,
        sourceFingerprint: this.sourceFingerprint,
      })
      this.initialized = state.initialized
      this.resetAt = state.resetAt
    } catch {
      await this.access.closeAfterFailure("before acquisition")
      throw sandboxError(
        "could not be acquired. Reload the thread; recovery or source verification may be required."
      )
    }
  }

  private async createOrResume(): Promise<Sandbox> {
    await this.assertCanContinue()
    try {
      if (!this.initialized) return await this.wait(this.create())

      const resumed = await this.wait(
        this.resume(this.name, {
          ...this.access.sessionOptions,
          requestCredentials: this.access.requestCredentials,
        })
      )
      this.resumed = true
      return resumed
    } catch (error) {
      if (!this.initialized || !(error instanceof SandboxStateUnavailableError)) throw error
      await this.replaceLostState()
      // One attempt, never a retry loop. Failed creation is quarantined under its new name.
      return this.wait(this.create())
    }
  }

  private create(): Promise<Sandbox> {
    return this.input.context.sandboxes.create({
      ...this.access.sessionOptions,
      requestCredentials: this.access.requestCredentials,
      signal: this.input.signal,
      environment: { source: this.recipe.source, setup: this.recipe.setup },
      persistence: { name: this.name },
    })
  }

  private async replaceLostState(): Promise<void> {
    await this.assertCanContinue()
    const { context, session, thread } = this.input
    const state = await session.workspace.transition({
      id: thread.id,
      action: "replace",
      name: this.name,
      nextName: createAgentThreadSandboxName(context.id, thread.id),
    })
    this.name = state.name
    this.resetAt = state.resetAt
    this.initialized = false
    await this.assertCanContinue()
  }

  private async quarantineAcquisition(error: unknown, session?: Sandbox): Promise<void> {
    await this.access.closeAfterFailure("during acquisition")
    // Never destroy persistent state. Lost/uncertain acquisition is quarantined, not retried.
    try {
      await this.assertOwner()
      if (session) await bounded(session.stop())
      await this.settle(error instanceof SandboxStateUnavailableError ? "unavailable" : "blocked")
    } catch {
      // Durable busy ownership remains when reconciliation cannot be confirmed.
      console.error(
        "[SixbAgentWorker] Sandbox recovery could not be recorded; ownership remains unresolved."
      )
    }
  }

  private runSandbox(session: Sandbox): PersistentRunSandbox {
    const acquired: AcquiredRunSandbox = {
      sandbox: this.guard(session),
      env: this.access.sessionOptions.env ?? {},
      // A sub-agent's prompt describes no workspace, as for its ephemeral sandbox: it finds its
      // files where it left them, and is told only when they were lost.
      ...(this.input.thread.kind === "subagent"
        ? {}
        : { promptContext: this.access.promptContext(session, "persistent") }),
      resetAt: this.resetAt,
    }
    // No release: the thread keeps its sandbox. beforeFinalize saves or quarantines it, or destroys
    // a sub-agent's that ended; a lost execution leaves it to the run's current owner.
    return {
      waitBeforeModel: true,
      contextDirectory: SANDBOX_CONTEXT_DIRECTORY,
      resumed: this.resumed,
      acquire: async () => acquired,
      beforeFinalize: (options?: BeforeFinalizeOptions) => {
        if (!this.saving) {
          this.closed = true
          this.saving = options?.discard
            ? this.discard(session)
            : this.input.thread.kind === "subagent"
              ? this.keepPaused(session)
              : this.preserve(session)
        }
        return this.saving
      },
    }
  }

  private guard(session: Sandbox): Sandbox {
    const { signal } = this.input
    return {
      id: session.id,
      provider: session.provider,
      get status() {
        return session.status
      },
      workingDirectory: session.workingDirectory,
      ...(session.credentialedUrl
        ? { credentialedUrl: session.credentialedUrl.bind(session) }
        : {}),
      runCommand: (command, args, options) =>
        this.track(() =>
          session.runCommand(command, args, {
            ...options,
            signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
          })
        ),
      writeFiles: (files) => this.track(() => session.writeFiles(files)),
      stop: () => Promise.reject(sandboxError("lifecycle is owned by the execution environment.")),
      destroy: () => Promise.reject(sandboxError("cannot be destroyed by run teardown.")),
    }
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(sandboxError("is being saved."))
    const result = (async () => {
      this.input.signal.throwIfAborted()
      await this.assertCanContinue()
      try {
        return await operation()
      } catch (error) {
        // A transport rejection does not prove the VM rejected the operation. A late write
        // could race transient-file cleanup, so this name must not become reusable.
        this.uncertainOperation = true
        throw error
      }
    })()
    this.pending.add(result)
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result)
    )
    return result
  }

  private async preserve(session: Sandbox): Promise<void> {
    let stopAttempted = false
    try {
      await bounded(Promise.allSettled([...this.pending]))
      await this.assertOwner()
      await this.access.close()
      if (this.uncertainOperation) throw sandboxError("has an unconfirmed sandbox operation.")
      await prepareWorkspaceRunFiles(session, this.recipe.source !== undefined)
      await this.assertOwner()
      stopAttempted = true
      await bounded(session.stop())
      await this.settle("ready")
    } catch (error) {
      try {
        await this.access.close()
      } catch {
        // close is memoized and the sandbox remains quarantined below.
      }
      try {
        await this.assertOwner()
        // Failed cleanup still closes the owned VM. Stopping is not proof of clean state.
        if (!stopAttempted) await bounded(session.stop())
        await this.settle("blocked")
      } catch {
        console.error(
          "[SixbAgentWorker] Sandbox save could not be reconciled; ownership remains unresolved."
        )
      }
      if (error instanceof AgentExecutionLostError) throw error
      throw new AgentEnvironmentSaveError()
    }
  }

  /**
   * Save the workspace of a sub-agent that pauses, which pauses whatever happens here: its handed
   * files and out/ are stored, so a continuation that finds the workspace unsaved starts again
   * from them. A stopped VM that could not be saved is destroyed.
   */
  private async keepPaused(session: Sandbox): Promise<void> {
    try {
      await this.preserve(session)
    } catch (error) {
      if (error instanceof AgentExecutionLostError) throw error

      console.error(
        `[SixbAgentWorker] The workspace of thread '${this.input.thread.id}' could not be saved; its continuation starts again from its handed files and out/.`
      )
      await bounded(session.destroy()).catch((cleanup: unknown) => {
        console.error(
          `[SixbAgentWorker] The unsaved workspace of thread '${this.input.thread.id}' could not be destroyed; the sandbox provider's retention removes it.`,
          cleanup
        )
      })
    }
  }

  /**
   * Destroy the workspace of a sub-agent run that ends without pausing: answered, failed or
   * stopped. Its files are mid-work, never a point its thread goes on from; a later continuation
   * (a retried turn, an answer after a dead attempt) starts again from the handed files and the
   * paused run's out/. The run's outcome stands whatever happens here, so a failure is reported
   * and left to the provider's retention.
   */
  private async discard(session: Sandbox): Promise<void> {
    try {
      await bounded(Promise.allSettled([...this.pending]))
      await this.assertOwner()
      await this.access.close()
      await bounded(session.destroy())
      await this.settle("unavailable")
    } catch (error) {
      if (error instanceof AgentExecutionLostError) throw error

      console.error(
        `[SixbAgentWorker] The workspace of thread '${this.input.thread.id}' could not be destroyed; the sandbox provider's retention removes it.`,
        error
      )
      try {
        await this.assertOwner()
        await this.settle("blocked")
      } catch {
        // A state left busy is started again by the thread's next run, as a blocked one is.
      }
    }
  }

  private settle(status: "ready" | "blocked" | "unavailable") {
    const { session, thread } = this.input
    return session.workspace.transition({
      id: thread.id,
      action: "settle",
      name: this.name,
      status,
      initialized: this.initialized,
    })
  }

  private assertOwner(): Promise<void> {
    return this.input.session.assertOwned()
  }

  private async assertCanContinue(): Promise<void> {
    await this.assertOwner()
    this.input.signal.throwIfAborted()
  }

  private wait(operation: Promise<Sandbox>): Promise<Sandbox> {
    return waitForAbort(bounded(operation), this.input.signal)
  }
}

function acquisitionError(error: unknown): Error {
  if (error instanceof AgentExecutionLostError) return error
  // The repository itself must change: say how instead of asking for recovery.
  if (error instanceof WorkspaceRunFilesConflictError) return error
  return sandboxError(
    error instanceof SandboxStateUnavailableError
      ? "saved files are unavailable. Recreate explicitly to start fresh."
      : "initialization or resume failed. Existing state was not deleted; explicit recovery is required."
  )
}
