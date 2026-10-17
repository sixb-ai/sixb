import type { Sandbox, SandboxEnvironment, SandboxFactory, SandboxSourceAuth } from "@sixb/core"
import type { AcquiredRunSandbox, RunSandbox } from "./run-sandbox"
import type { AgentSandboxHandle } from "./sandbox-handle"
import type { AgentExecutionContext } from "./types"
import { WorkspaceAccess } from "./workspace-access"
import { prepareWorkspaceRunFiles } from "./workspace-files"

/** A blank sandbox without a workspace, a workspace prepared from a recipe with one. */
type EphemeralRunSandboxInput = BlankRunSandboxInput | WorkspaceRunSandboxInput

interface BlankRunSandboxInput {
  /** The run's context: its project factory creates the sandbox, which reaches its Sixb API. */
  readonly context: Pick<AgentExecutionContext, "sandboxes" | "apiBaseUrl">
  /**
   * Cancels creation: on cancellation, lost ownership, worker shutdown (which aborts the queue
   * delivery) or a deadline. It must never fire because the run completed: a sandbox still
   * booting then would be abandoned to the provider's failure cleanup instead of destroyed.
   */
  readonly signal?: AbortSignal
  readonly workspace?: undefined
}

interface WorkspaceRunSandboxInput {
  /** The run's context: the workspace reaches its Sixb API. */
  readonly context: Pick<AgentExecutionContext, "apiBaseUrl">
  /**
   * Cancels creation, with its clone and setup, and stops credential renewal. As for a blank
   * sandbox, it must never fire because the run completed.
   */
  readonly signal: AbortSignal
  readonly workspace: EphemeralWorkspaceInput
}

interface EphemeralWorkspaceInput {
  /** The run the workspace is for, named in its logs. */
  readonly runId: string
  readonly factory: SandboxFactory
  /** The static source, setup, env and network to prepare the workspace from. */
  readonly recipe: SandboxEnvironment
  /** The factory's source authentication: it issues the source's credentials host-side. */
  readonly auth?: SandboxSourceAuth
  /** Fences each provider action on the run's ownership. */
  readonly assertOwner: () => Promise<void>
  /** The source credentials were lost: the run must stop. */
  readonly onAuthFailure: (error: Error) => void
}

/**
 * A sandbox created for one run and destroyed when the run releases it.
 *
 * Without a workspace it is blank: no source or setup, and only the Sixb API on the network. The
 * prompt describes nothing about it, so it boots concurrently with the first model call.
 *
 * With one it is a workspace prepared from its recipe, which the prompt describes.
 */
export function ephemeralRunSandbox(input: EphemeralRunSandboxInput): RunSandbox {
  const apiOrigin = new URL(input.context.apiBaseUrl).origin
  if (input.workspace) return new EphemeralWorkspace(input, apiOrigin)

  const { context, signal } = input

  return {
    waitBeforeModel: false,
    acquire: async () => ({
      sandbox: await context.sandboxes.create({
        environment: {},
        network: { mode: "restricted", allow: [{ name: "sixb-api", origin: apiOrigin }] },
        ...(signal ? { signal } : {}),
      }),
    }),
    release: (acquired) => acquired.sandbox.destroy(),
  }
}

/**
 * A fresh workspace from a static recipe: its source, setup, env and network, with source
 * credentials issued host-side. Never resumed, and destroyed on release after its credentials
 * are removed and revoked.
 */
class EphemeralWorkspace implements RunSandbox {
  // The prompt describes every prepared workspace, at least its working directory and that it is
  // discarded, so the first model call waits for it, with or without a source.
  readonly waitBeforeModel = true
  private readonly workspace: EphemeralWorkspaceInput
  private readonly signal: AbortSignal
  private readonly access: WorkspaceAccess
  private closing: Promise<void> | undefined

  constructor(input: WorkspaceRunSandboxInput, apiOrigin: string) {
    const { workspace, signal } = input
    this.workspace = workspace
    this.signal = signal

    this.access = new WorkspaceAccess({
      recipe: workspace.recipe,
      auth: workspace.auth,
      factory: workspace.factory,
      apiOrigin,
      signal,
      assertOwner: workspace.assertOwner,
      onAuthFailure: workspace.onAuthFailure,
    })
  }

  async acquire(): Promise<AcquiredRunSandbox> {
    await this.assertCanContinue()
    await this.authorize()

    let sandbox: Sandbox | undefined
    try {
      sandbox = await this.create()
      await this.assertCanContinue()
      this.access.attach(sandbox)

      // Run files hold the gateway capability: exclude them from Git before any is written.
      await prepareWorkspaceRunFiles(sandbox, this.workspace.recipe.source !== undefined)
      await this.assertCanContinue()
    } catch (error) {
      await this.discard(sandbox).catch((cleanup: unknown) => {
        console.error(
          `[SixbAgentWorker] Could not destroy the workspace of run '${this.workspace.runId}':`,
          cleanup
        )
      })
      throw error
    }

    return {
      sandbox,
      env: this.access.sessionOptions.env ?? {},
      promptContext: this.access.promptContext(sandbox, "ephemeral"),
    }
  }

  /** Remove injection and revoke while this run still owns its work, before its terminal write. */
  beforeFinalize(): Promise<void> {
    return this.closeCredentials()
  }

  release(acquired: AgentSandboxHandle): Promise<void> {
    return this.discard(acquired.sandbox)
  }

  /** A failed authorization has already closed what it issued and reported a failed close. */
  private async authorize(): Promise<void> {
    try {
      await this.access.authorize()
    } catch (error) {
      this.closing = Promise.resolve()
      throw error
    }
  }

  /** Clone and set up with the run's signal: both share the run's time budget. */
  private create(): Promise<Sandbox> {
    const { factory, recipe } = this.workspace

    return factory.create({
      ...this.access.sessionOptions,
      requestCredentials: this.access.requestCredentials,
      signal: this.signal,
      environment: { source: recipe.source, setup: recipe.setup },
    })
  }

  /** Revoke before destroying: no grant outlives the session it was issued for. */
  private async discard(sandbox: Sandbox | undefined): Promise<void> {
    await this.closeCredentials()
    await sandbox?.destroy()
  }

  /**
   * Close once, never failing the run: the sandbox is destroyed next and the token never entered
   * the guest. Removing injection needs the run's ownership, so only an unrevoked grant is worth
   * reporting.
   */
  private closeCredentials(): Promise<void> {
    this.closing ??= this.access.close().catch(() => {
      if (this.access.revoked) return

      console.error(
        `[SixbAgentWorker] The workspace credentials of run '${this.workspace.runId}' could not be revoked; they stay valid until they expire.`
      )
    })
    return this.closing
  }

  private async assertCanContinue(): Promise<void> {
    await this.workspace.assertOwner()
    this.signal.throwIfAborted()
  }
}
