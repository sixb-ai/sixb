import { createHash } from "node:crypto"
import type { Sandbox, SandboxDefinition, SandboxEnvironment, SandboxFactory } from "@sixb/core"
import { createAgentThreadSandboxName } from "@sixb/core/internal/agents"
import { SandboxStateUnavailableError, sandboxProjectDirectory } from "@sixb/core/sandboxes"
import type { AgentThreadRecord, ConversationAgentRunRecord } from "@sixb/core/storage"
import { waitForAbort } from "./abort"
import {
  AgentEnvironmentSaveError,
  AgentExecutionLostError,
  assertRunExecutionOwned,
} from "./errors"
import type { AcquiredRunSandbox, RunSandbox } from "./run-sandbox"
import { bounded, sandboxError } from "./sandbox-operation"
import type { AgentExecutionContext } from "./types"
import { WorkspaceAccess } from "./workspace-access"
import { prepareWorkspaceRunFiles } from "./workspace-files"

interface PersistentRunSandboxInput {
  readonly context: AgentExecutionContext
  readonly definition?: SandboxDefinition
  readonly thread: AgentThreadRecord
  readonly run: ConversationAgentRunRecord
  readonly signal: AbortSignal
  readonly onAuthFailure: (error: Error) => void
}

/**
 * A thread's workspace, kept across its runs: created by the first run from the resolved recipe,
 * resumed by each later one, and saved before every run's terminal write. Never destroyed.
 *
 * Resolve current authority before taking any provider action; never trust guest metadata.
 */
export async function persistentRunSandbox(input: PersistentRunSandboxInput): Promise<RunSandbox> {
  const { context, definition, thread, signal } = input
  const factory = context.sandboxes
  if (!definition || !thread.sandboxParams || typeof factory.resume !== "function") {
    throw sandboxError("requires a configured recipe and persistent sandbox provider.")
  }
  const recipe = structuredClone(
    await waitForAbort(
      bounded(definition.resolve({ params: thread.sandboxParams, sixb: context.sixb })),
      signal
    )
  )
  signal.throwIfAborted()
  return new PersistentSandboxSession(input, recipe, factory.resume.bind(factory)).open()
}

/** One execution owns acquisition, guarded operations and preservation of its provider session. */
class PersistentSandboxSession {
  private readonly access: WorkspaceAccess
  private readonly sourceFingerprint: string
  private readonly executionToken: string
  private name: string
  private initialized = false
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
    const { context, definition, thread, run, signal, onAuthFailure } = input
    this.access = new WorkspaceAccess({
      recipe,
      auth: definition?.auth,
      factory: context.sandboxes,
      apiOrigin: new URL(context.apiBaseUrl).origin,
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
    if (!run.execution?.token) throw new AgentExecutionLostError(run.id)
    this.executionToken = run.execution.token
    this.name = thread.sandboxState?.name ?? createAgentThreadSandboxName(context.id, thread.id)
    if (
      thread.sandboxState?.sourceFingerprint &&
      thread.sandboxState.sourceFingerprint !== this.sourceFingerprint
    ) {
      throw sandboxError(
        "source identity changed. Restore the configured repository and initial revision to resume this checkout."
      )
    }
  }

  async open(): Promise<RunSandbox> {
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

  private async acquireOwnership(): Promise<void> {
    const { context, thread, run } = this.input
    try {
      const state = await context.storage.agents.threads.transitionSandbox({
        projectId: context.id,
        id: thread.id,
        action: "acquire",
        runId: run.id,
        executionToken: this.executionToken,
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
      return await this.wait(
        this.initialized
          ? this.resume(this.name, {
              ...this.access.sessionOptions,
              // An empty list confirms that this run's recipe needs no source auth.
              requestCredentials:
                this.access.requestCredentials ?? (this.input.definition?.auth ? [] : undefined),
            })
          : this.create()
      )
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
    const { context, thread, run } = this.input
    const state = await context.storage.agents.threads.transitionSandbox({
      projectId: context.id,
      id: thread.id,
      action: "replace",
      runId: run.id,
      executionToken: this.executionToken,
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

  private runSandbox(session: Sandbox): RunSandbox {
    const acquired: AcquiredRunSandbox = {
      sandbox: this.guard(session),
      env: this.access.sessionOptions.env ?? {},
      promptContext: this.access.promptContext(session),
      resetAt: this.resetAt,
    }
    // No release: the thread keeps its sandbox. beforeFinalize saves or quarantines it; a lost
    // execution leaves it to the run's current owner.
    return {
      waitBeforeModel: true,
      acquire: async () => acquired,
      beforeFinalize: () => {
        if (!this.saving) {
          this.closed = true
          this.saving = this.preserve(session)
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

  private settle(status: "ready" | "blocked" | "unavailable") {
    const { context, thread, run } = this.input
    return context.storage.agents.threads.transitionSandbox({
      projectId: context.id,
      id: thread.id,
      action: "settle",
      runId: run.id,
      executionToken: this.executionToken,
      name: this.name,
      status,
      initialized: this.initialized,
    })
  }

  private assertOwner(): Promise<void> {
    const { context, run } = this.input
    return assertRunExecutionOwned(context.storage, {
      projectId: context.id,
      id: run.id,
      executionToken: this.executionToken,
    })
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
  return sandboxError(
    error instanceof SandboxStateUnavailableError
      ? "saved files are unavailable. Recreate explicitly to start fresh."
      : "initialization or resume failed. Existing state was not deleted; explicit recovery is required."
  )
}
