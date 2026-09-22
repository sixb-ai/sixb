import { createHash } from "node:crypto"
import type {
  Sandbox,
  SandboxDefinition,
  SandboxEnvironment,
  SandboxFactory,
  SandboxSessionOptions,
} from "@sixb/core"
import { createAgentThreadSandboxName } from "@sixb/core/internal/agents"
import { createSixbError } from "@sixb/core/internal/errors"
import { SandboxStateUnavailableError, sandboxProjectDirectory } from "@sixb/core/sandboxes"
import type { AgentThreadRecord, ConversationAgentRunRecord } from "@sixb/core/storage"
import { waitForAbort } from "./abort"
import type { AgentWorkspacePromptContext } from "./agent-prompt"
import { AgentEnvironmentSaveError, AgentExecutionLostError } from "./errors"
import type { AgentExecutionContext } from "./types"
import { WorkspaceAuthSession } from "./workspace-auth"
import { workspaceRunFilesScript } from "./workspace-files"
import { workspaceNetwork } from "./workspace-network"

const OPERATION_TIMEOUT_MS = 120_000

export interface AgentSandboxLifecycle {
  readonly promptContext: AgentWorkspacePromptContext
  readonly sandbox: Sandbox
  readonly env: Readonly<Record<string, string>>
  readonly resetAt?: string
  save(): Promise<void>
}

interface OpenThreadSandboxInput {
  readonly context: AgentExecutionContext
  readonly definition?: SandboxDefinition
  readonly thread: AgentThreadRecord
  readonly run: ConversationAgentRunRecord
  readonly signal: AbortSignal
  readonly onAuthFailure: (error: Error) => void
}

/** Resolve current authority before taking any provider action; never trust guest metadata. */
export async function openThreadSandbox(
  input: OpenThreadSandboxInput
): Promise<AgentSandboxLifecycle> {
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
  return new ThreadSandboxSession(input, recipe, factory.resume.bind(factory)).open()
}

/** One execution owns acquisition, guarded operations and preservation of its provider session. */
class ThreadSandboxSession {
  private readonly sourceUrl: URL | undefined
  private readonly sourceFingerprint: string
  private readonly executionToken: string
  private options: SandboxSessionOptions
  private name: string
  private initialized = false
  private resetAt: string | undefined
  private auth: WorkspaceAuthSession | undefined
  private requestCredentials: SandboxSessionOptions["requestCredentials"]
  private readonly pending = new Set<Promise<unknown>>()
  private saving: Promise<void> | undefined
  private closed = false
  private uncertainOperation = false

  constructor(
    private readonly input: OpenThreadSandboxInput,
    private readonly recipe: SandboxEnvironment,
    private readonly resume: NonNullable<SandboxFactory["resume"]>
  ) {
    const { context, thread, run } = input
    this.sourceUrl = recipe.source ? new URL(recipe.source.url) : undefined
    this.options = {
      env: recipe.env,
      network: this.network(!thread.sandboxState?.initialized),
    }
    // Compare recipe identity, not the mutable branch/remote in the guest.
    this.sourceFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          url: this.sourceUrl?.href ?? null,
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

  async open(): Promise<AgentSandboxLifecycle> {
    await this.prepareAuthentication()
    await this.acquireOwnership()
    let session: Sandbox | undefined
    try {
      const acquired = await this.createOrResume()
      session = this.initialized
        ? sandboxProjectDirectory(acquired, this.recipe.source !== undefined)
        : acquired
      await this.assertCanContinue()
      this.auth?.attach(session)
      this.initialized = true
      await cleanRunFiles(session, this.recipe.source !== undefined)
      await this.assertCanContinue()
    } catch (error) {
      await this.quarantineAcquisition(error, session)
      throw acquisitionError(error)
    }
    return this.lifecycle(session)
  }

  private async prepareAuthentication(): Promise<void> {
    const { context, definition, signal, onAuthFailure } = this.input
    if (!this.recipe.source || !definition?.auth) {
      if (this.recipe.source?.access === "write") {
        throw sandboxError("write access requires source authentication.")
      }
      return
    }
    if (!context.sandboxes.supportsRequestCredentials) {
      throw sandboxError("authentication requires a provider with secure credential injection.")
    }
    this.auth = new WorkspaceAuthSession({
      auth: definition.auth,
      source: this.recipe.source,
      signal,
      assertOwner: () => this.assertOwner(),
      onFailure: onAuthFailure,
    })
    try {
      this.requestCredentials = await this.auth.prepare()
    } catch (error) {
      await this.closeAuthenticationAfterFailure("before acquisition")
      throw error
    }
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
      await this.closeAuthenticationAfterFailure("before acquisition")
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
              ...this.options,
              // An empty list confirms that this run's recipe needs no source auth.
              requestCredentials:
                this.requestCredentials ?? (this.input.definition?.auth ? [] : undefined),
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
      ...this.options,
      requestCredentials: this.requestCredentials,
      signal: this.input.signal,
      environment: { source: this.recipe.source, setup: this.recipe.setup },
      persistence: { name: this.name },
    })
  }

  private async replaceLostState(): Promise<void> {
    await this.assertCanContinue()
    // A fresh clone needs source access even if the resume policy no longer allowed it.
    this.options = { ...this.options, network: this.network(true) }
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
    await this.closeAuthenticationAfterFailure("during acquisition")
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

  private lifecycle(session: Sandbox): AgentSandboxLifecycle {
    return {
      sandbox: this.guard(session),
      promptContext: {
        workingDirectory: session.workingDirectory,
        ...(this.recipe.source && this.sourceUrl
          ? {
              source: {
                type: this.recipe.source.type,
                url: this.sourceUrl.href,
                ...(this.auth ? { authenticatedAccess: this.recipe.source.access ?? "read" } : {}),
              },
            }
          : {}),
      },
      env: this.recipe.env ?? {},
      resetAt: this.resetAt,
      save: () => {
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
      await this.auth?.close()
      if (this.uncertainOperation) throw sandboxError("has an unconfirmed sandbox operation.")
      await cleanRunFiles(session, this.recipe.source !== undefined)
      await this.assertOwner()
      stopAttempted = true
      await bounded(session.stop())
      await this.settle("ready")
    } catch (error) {
      try {
        await this.auth?.close()
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

  private async assertOwner(): Promise<void> {
    const { context, run } = this.input
    const current = await context.storage.agents.runs.getById({ projectId: context.id, id: run.id })
    if (
      current?.status !== "running" ||
      current.execution?.token !== this.executionToken ||
      current.execution.queueLeaseExpiresAt.getTime() <= Date.now()
    ) {
      throw new AgentExecutionLostError(run.id)
    }
  }

  private async assertCanContinue(): Promise<void> {
    await this.assertOwner()
    this.input.signal.throwIfAborted()
  }

  private network(initializing: boolean) {
    return workspaceNetwork(
      this.recipe.network,
      new URL(this.input.context.apiBaseUrl).origin,
      this.sourceUrl?.origin,
      initializing
    )
  }

  private wait(operation: Promise<Sandbox>): Promise<Sandbox> {
    return waitForAbort(bounded(operation), this.input.signal)
  }

  private async closeAuthenticationAfterFailure(phase: string): Promise<void> {
    try {
      await this.auth?.close()
    } catch {
      console.error(`[SixbAgentWorker] Sandbox authentication cleanup failed ${phase}.`)
    }
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

function sandboxError(message: string): Error {
  return createSixbError("agent.execution_failed", `[SixbAgentWorker] Sandbox ${message}`)
}

/** Remove only framework-owned transient files. Refuse a redirected parent directory. */
async function cleanRunFiles(sandbox: Sandbox, hasSource: boolean): Promise<void> {
  const result = await bounded(
    sandbox.runCommand("bash", ["-c", workspaceRunFilesScript(hasSource)], {
      timeout: OPERATION_TIMEOUT_MS,
    })
  )
  if (result.exitCode !== 0 || result.timedOut) throw sandboxError("command failed.")
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(sandboxError("operation timed out; its outcome is uncertain.")),
        OPERATION_TIMEOUT_MS
      )
    }),
  ]).finally(() => clearTimeout(timer))
}
