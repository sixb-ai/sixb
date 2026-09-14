import { createHash, randomUUID } from "node:crypto"
import { posix } from "node:path"
import type { AgentWorkspaceDefinition, Sandbox, Sixb } from "@sixb/core"
import { createSixbError } from "@sixb/core/internal/errors"
import { SandboxStateUnavailableError } from "@sixb/core/sandboxes"
import type {
  AgentThreadRecord,
  AgentWorkspaceState,
  ConversationAgentRunRecord,
} from "@sixb/core/storage"
import { waitForAbort } from "./abort"
import type { AgentWorkspacePromptContext } from "./agent-prompt"
import { AgentExecutionLostError } from "./errors"
import type { AgentExecutionContext } from "./types"
import { WorkspaceAuthSession } from "./workspace-auth"
import { workspaceNetwork } from "./workspace-network"

const OPERATION_TIMEOUT_MS = 120_000

export interface AgentWorkspaceLifecycle {
  readonly promptContext: AgentWorkspacePromptContext
  readonly sandbox: Sandbox
  readonly env: Readonly<Record<string, string>>
  save(): Promise<void>
}

function workspaceError(message: string): Error {
  return createSixbError("agent.execution_failed", `[SixbAgentWorker] Workspace ${message}`)
}

/** Resolve current authority before taking any provider action; never trust guest metadata. */
export async function openAgentWorkspace(input: {
  readonly context: AgentExecutionContext
  readonly sixb: Sixb
  readonly definition?: AgentWorkspaceDefinition
  readonly thread: AgentThreadRecord
  readonly run: ConversationAgentRunRecord
  readonly signal: AbortSignal
  readonly onAuthFailure: (error: Error) => void
}): Promise<AgentWorkspaceLifecycle> {
  const { context, thread, run, signal } = input
  const persistence = context.sandboxes.persistence
  if (!input.definition || !thread.workspace || !persistence) {
    throw workspaceError("requires a configured recipe and persistent sandbox provider.")
  }
  const recipe = structuredClone(
    await waitForAbort(
      bounded(
        input.definition.resolve({
          params: thread.workspace.params,
          sixb: input.sixb,
        })
      ),
      signal
    )
  )
  signal.throwIfAborted()
  // Credentials are delivered separately, never embedded in the Git URL.
  let url: URL
  try {
    url = new URL(recipe.source.url)
  } catch {
    throw workspaceError("source URL is invalid.")
  }
  if (
    recipe.source.access !== undefined &&
    recipe.source.access !== "read" &&
    recipe.source.access !== "write"
  )
    throw workspaceError("source access must be read or write.")
  if (
    recipe.source.type !== "git" ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    throw workspaceError("source must be a credential-free HTTPS Git repository.")
  }
  if (
    recipe.source.revision !== undefined &&
    (!recipe.source.revision ||
      recipe.source.revision.startsWith("-") ||
      /[\x00-\x1f]/.test(recipe.source.revision))
  ) {
    throw workspaceError("source revision is invalid.")
  }
  if (recipe.setup?.some((command) => typeof command !== "string" || !command.trim())) {
    throw workspaceError("setup commands must be non-empty strings.")
  }
  if (
    recipe.env &&
    Object.entries(recipe.env).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")
    )
  )
    throw workspaceError("environment must contain valid names and string values.")
  const options = {
    network: workspaceNetwork(recipe.network, new URL(context.apiBaseUrl).origin, url.origin),
  }
  // Compare recipe identity, not the mutable branch/remote in the guest.
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        url: url.href,
        revision: recipe.source.revision ?? null,
      })
    )
    .digest("hex")
  const executionToken = run.execution?.token
  if (!executionToken) throw new AgentExecutionLostError(run.id)
  const generation = thread.workspaceState?.generation ?? randomUUID()
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
  const name = `sixb-ws-${createHash("sha256")
    .update(JSON.stringify([context.id, thread.id, generation]))
    .digest("hex")}`
  let sandbox: Sandbox | undefined
  let auth: WorkspaceAuthSession | undefined
  let initialized = state.initialized
  try {
    await assertOwner()
    signal.throwIfAborted()
    const acquired = await waitForAbort(
      bounded(initialized ? persistence.resume(name, options) : persistence.create(name, options)),
      signal
    )
    // Stay inside the provider's writable root; never assume the guest can create /sixb.
    sandbox = repositorySandbox(acquired)
    await assertOwner()
    signal.throwIfAborted()
    if (input.definition.auth) {
      auth = new WorkspaceAuthSession({
        auth: input.definition.auth,
        source: recipe.source,
        sandbox: acquired,
        signal,
        assertOwner,
        onFailure: input.onAuthFailure,
      })
      await auth.start()
    }
    if (!initialized) {
      await checkedCommand(acquired, "git", ["clone", "--", url.href, "repository"], { signal })
      if (recipe.source.revision) {
        await checkedCommand(sandbox, "git", ["checkout", recipe.source.revision, "--"], {
          signal,
        })
      }
      for (const command of recipe.setup ?? []) {
        await assertOwner()
        await checkedCommand(sandbox, "bash", ["-lc", command], { signal, env: recipe.env })
      }
      initialized = true
    }
    await cleanRunFiles(sandbox)
    await assertOwner()
    signal.throwIfAborted()
  } catch (error) {
    try {
      await auth?.close()
    } catch {
      console.error("[SixbAgentWorker] Workspace authentication cleanup failed during acquisition.")
    }
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
    promptContext: {
      workingDirectory: guarded.workingDirectory,
      source: {
        type: recipe.source.type,
        url: url.href,
        ...(auth ? { authenticatedAccess: recipe.source.access ?? "read" } : {}),
      },
    },
    env: recipe.env ?? {},
    save() {
      if (saving) return saving
      closed = true
      saving = (async () => {
        let stopAttempted = false
        try {
          await bounded(Promise.allSettled([...pending]))
          await assertOwner()
          await auth?.close()
          if (uncertainOperation) throw workspaceError("has an unconfirmed sandbox operation.")
          await cleanRunFiles(session)
          await assertOwner()
          stopAttempted = true
          await bounded(session.stop())
          await transition("ready", true)
        } catch (error) {
          try {
            await auth?.close()
          } catch {
            // close is memoized and the workspace remains quarantined below.
          }
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
async function cleanRunFiles(sandbox: Sandbox): Promise<void> {
  await checkedCommand(sandbox, "bash", [
    "-c",
    'git rev-parse --git-dir >/dev/null && test ! -L .sixb && test -z "$(git ls-files -- .sixb/agent)" && rm -rf -- .sixb/agent',
  ])
}

/** Keep checkout-relative commands/files inside the provider-owned writable directory. */
function repositorySandbox(session: Sandbox): Sandbox {
  const workingDirectory = posix.join(session.workingDirectory, "repository")
  return {
    id: session.id,
    provider: session.provider,
    get status() {
      return session.status
    },
    workingDirectory,
    runCommand: (command, args, options) =>
      session.runCommand(command, args, {
        ...options,
        cwd: options?.cwd ?? workingDirectory,
      }),
    writeFiles: (files) =>
      session.writeFiles(
        files.map((file) => ({
          ...file,
          path: posix.isAbsolute(file.path) ? file.path : posix.join(workingDirectory, file.path),
        }))
      ),
    stop: () => session.stop(),
    destroy: () => session.destroy(),
  }
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
