import { createHash, randomUUID } from "node:crypto"
import type { Sandbox, SandboxDefinition, Sixb } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { SandboxStateUnavailableError, sandboxProjectDirectory } from "@sixb/core/sandboxes"
import type {
  AgentThreadRecord,
  AgentWorkspaceState,
  ConversationAgentRunRecord,
} from "@sixb/core/storage"
import { waitForAbort } from "./abort"
import { AgentExecutionLostError } from "./errors"
import type { AgentExecutionContext } from "./types"
import { workspaceRunFilesScript } from "./workspace-files"
import { workspaceNetwork } from "./workspace-network"

const OPERATION_TIMEOUT_MS = 120_000

export interface AgentWorkspaceLifecycle {
  readonly sandbox: Sandbox
  readonly env: Readonly<Record<string, string>>
  readonly resetAt?: string
  save(): Promise<void>
}

function workspaceError(message: string): Error {
  return createSixbError("agent.execution_failed", `[SixbAgentWorker] Workspace ${message}`)
}

/** Resolve current authority before taking any provider action; never trust guest metadata. */
export async function openAgentWorkspace(input: {
  readonly context: AgentExecutionContext
  readonly sixb: Sixb
  readonly definition?: SandboxDefinition
  readonly thread: AgentThreadRecord
  readonly run: ConversationAgentRunRecord
  readonly signal: AbortSignal
}): Promise<AgentWorkspaceLifecycle> {
  const { context, thread, run, signal } = input
  const factory = context.sandboxes
  if (!input.definition || !thread.sandbox || typeof factory.resume !== "function") {
    throw workspaceError("requires a configured recipe and persistent sandbox provider.")
  }
  const recipe = structuredClone(
    await waitForAbort(
      bounded(
        input.definition.resolve({
          params: thread.sandbox,
          sixb: input.sixb,
        })
      ),
      signal
    )
  )
  signal.throwIfAborted()
  const url = recipe.source ? new URL(recipe.source.url) : undefined
  const options = {
    env: recipe.env,
    network: workspaceNetwork(
      recipe.network,
      new URL(context.apiBaseUrl).origin,
      url?.origin,
      !thread.workspaceState?.initialized
    ),
  }
  // Compare recipe identity, not the mutable branch/remote in the guest.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        url: url?.href ?? null,
        revision: recipe.source?.revision ?? null,
      })
    )
    .digest("hex")
  const executionToken = run.execution?.token
  if (!executionToken) throw new AgentExecutionLostError(run.id)
  let generation = thread.workspaceState?.generation ?? randomUUID()
  if (
    thread.workspaceState?.sourceFingerprint &&
    thread.workspaceState.sourceFingerprint !== fingerprint
  ) {
    throw workspaceError(
      "source identity changed. Restore the configured repository and initial revision to resume this checkout."
    )
  }
  const transition = (status: "ready" | "blocked" | "unavailable", initialized: boolean) =>
    context.storage.agents.threads.transitionWorkspace({
      projectId: context.id,
      id: thread.id,
      action: "settle",
      runId: run.id,
      executionToken,
      generation,
      status,
      initialized,
    })
  const assertOwner = async () => {
    const current = await context.storage.agents.runs.getById({ projectId: context.id, id: run.id })
    if (
      current?.status !== "running" ||
      current.execution?.token !== executionToken ||
      current.execution.queueLeaseExpiresAt.getTime() <= Date.now()
    ) {
      throw new AgentExecutionLostError(run.id)
    }
  }
  let state: AgentWorkspaceState
  try {
    state = await context.storage.agents.threads.transitionWorkspace({
      projectId: context.id,
      id: thread.id,
      action: "acquire",
      runId: run.id,
      executionToken,
      generation,
      sourceFingerprint: fingerprint,
    })
  } catch {
    throw workspaceError(
      "could not be acquired. Reload the thread; recovery or source verification may be required."
    )
  }
  // Include project + thread in the namespace; a new generation never touches the previous name.
  const sandboxName = () =>
    `sixb-ws-${createHash("sha256")
      .update(JSON.stringify([context.id, thread.id, generation]))
      .digest("hex")}`
  let sandbox: Sandbox | undefined
  let initialized = state.initialized
  const create = () =>
    factory.create({
      ...options,
      signal,
      environment: { source: recipe.source, setup: recipe.setup },
      persistence: { name: sandboxName() },
    })
  try {
    await assertOwner()
    signal.throwIfAborted()
    let acquired: Sandbox
    try {
      acquired = await waitForAbort(
        bounded(initialized ? factory.resume(sandboxName(), options) : create()),
        signal
      )
    } catch (error) {
      if (!initialized || !(error instanceof SandboxStateUnavailableError)) throw error
      await assertOwner()
      signal.throwIfAborted()
      // A fresh clone needs source access even when the resume policy no longer allowed it.
      options.network = workspaceNetwork(
        recipe.network,
        new URL(context.apiBaseUrl).origin,
        url?.origin
      )
      const replacement = await context.storage.agents.threads.transitionWorkspace({
        projectId: context.id,
        id: thread.id,
        action: "replace",
        runId: run.id,
        executionToken,
        generation,
        nextGeneration: randomUUID(),
      })
      state = replacement
      generation = replacement.generation
      initialized = false
      await assertOwner()
      signal.throwIfAborted()
      // One attempt, never a retry loop. Failed creation remains quarantined under its new name.
      acquired = await waitForAbort(bounded(create()), signal)
    }
    sandbox = initialized
      ? sandboxProjectDirectory(acquired, recipe.source !== undefined)
      : acquired
    await assertOwner()
    signal.throwIfAborted()
    initialized = true
    await cleanRunFiles(sandbox, recipe.source !== undefined)
    await assertOwner()
    signal.throwIfAborted()
  } catch (error) {
    // Never destroy persistent state. A lost/uncertain acquisition is quarantined, not retried.
    try {
      await assertOwner()
      if (sandbox) await bounded(sandbox.stop())
      await transition(
        error instanceof SandboxStateUnavailableError ? "unavailable" : "blocked",
        initialized
      )
    } catch {
      // Durable busy ownership remains in place when reconciliation cannot be confirmed.
      console.error(
        "[SixbAgentWorker] Workspace recovery could not be recorded; ownership remains unresolved."
      )
    }
    if (error instanceof AgentExecutionLostError) throw error
    throw workspaceError(
      error instanceof SandboxStateUnavailableError
        ? "saved files are unavailable. Recreate explicitly to start fresh."
        : "initialization or resume failed. Existing state was not deleted; explicit recovery is required."
    )
  }
  const session = sandbox
  const pending = new Set<Promise<unknown>>()
  let saving: Promise<void> | undefined
  let closed = false
  let uncertainOperation = false
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(workspaceError("is being saved."))
    const result = (async () => {
      signal.throwIfAborted()
      await assertOwner()
      signal.throwIfAborted()
      try {
        return await operation()
      } catch (error) {
        // A transport rejection does not prove the VM rejected the operation. Do not publish
        // this generation as clean/reusable if a late write could race transient-file cleanup.
        uncertainOperation = true
        throw error
      }
    })()
    pending.add(result)
    void result.then(
      () => pending.delete(result),
      () => pending.delete(result)
    )
    return result
  }
  const guarded: Sandbox = {
    id: session.id,
    provider: session.provider,
    get status() {
      return session.status
    },
    workingDirectory: session.workingDirectory,
    runCommand: (command, args, options) =>
      track(() =>
        session.runCommand(command, args, {
          ...options,
          signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
        })
      ),
    writeFiles: (files) => track(() => session.writeFiles(files)),
    stop: () => Promise.reject(workspaceError("lifecycle is owned by the worker.")),
    destroy: () => Promise.reject(workspaceError("cannot be destroyed by run teardown.")),
  }
  return {
    sandbox: guarded,
    env: recipe.env ?? {},
    resetAt: state.resetAt,
    save() {
      if (saving) return saving
      closed = true
      saving = (async () => {
        let stopAttempted = false
        try {
          await bounded(Promise.allSettled([...pending]))
          await assertOwner()
          if (uncertainOperation) throw workspaceError("has an unconfirmed sandbox operation.")
          await cleanRunFiles(session, recipe.source !== undefined)
          await assertOwner()
          stopAttempted = true
          await bounded(session.stop())
          await transition("ready", true)
        } catch (error) {
          try {
            await assertOwner()
            // Even failed cleanup must close the owned VM's network/process lifetime. Its
            // snapshot remains quarantined; stopping is not proof that cleanup succeeded.
            if (!stopAttempted) await bounded(session.stop())
            await transition("blocked", initialized)
          } catch {
            console.error(
              "[SixbAgentWorker] Workspace save could not be reconciled; ownership remains unresolved."
            )
          }
          if (error instanceof AgentExecutionLostError) throw error
          throw workspaceError("save or cleanup could not be confirmed. Recovery is required.")
        }
      })()
      return saving
    },
  }
}

async function checkedCommand(
  sandbox: Sandbox,
  command: string,
  args: readonly string[],
  options?: Parameters<Sandbox["runCommand"]>[2]
): Promise<void> {
  const result = await bounded(
    sandbox.runCommand(command, args, { timeout: OPERATION_TIMEOUT_MS, ...options })
  )
  if (result.exitCode !== 0 || result.timedOut) throw workspaceError("command failed.")
}

/** Remove only framework-owned transient files. Refuse a redirected parent directory. */
async function cleanRunFiles(sandbox: Sandbox, hasSource: boolean): Promise<void> {
  await checkedCommand(sandbox, "bash", ["-c", workspaceRunFilesScript(hasSource)])
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(workspaceError("operation timed out; its outcome is uncertain.")),
        OPERATION_TIMEOUT_MS
      )
    }),
  ]).finally(() => clearTimeout(timer))
}
