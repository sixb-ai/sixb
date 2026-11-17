import { type Sandbox, SandboxNotRunningError } from "@sixb/core"
import { createSixbError, withFailureMessage } from "@sixb/core/internal/errors"
import type { SandboxNetworkPolicy } from "@sixb/core/sandboxes"
import type { AgentWorkspacePromptContext } from "./agent-prompt"
import type { BackgroundCommands } from "./background-commands"
import type { WebFetchNetwork } from "./tools/web-fetch/network"
import { readWorkspaceInstructions } from "./workspace-instructions"

/**
 * Where a provider's sandbox keeps a run's files: in its working directory, which a Git checkout
 * excludes (see `prepareWorkspaceRunFiles`).
 */
export { SANDBOX_CONTEXT_DIRECTORY } from "@sixb/core/internal/agents"

/** The sandbox a run works in, with what the system prompt may say about it. */
export interface AcquiredRunSandbox {
  readonly sandbox: Sandbox
  /** The workspace's environment; provisioning adds the run's. */
  readonly env?: Readonly<Record<string, string>>
  /** Facts about a prepared workspace; absent for a blank sandbox. */
  readonly promptContext?: AgentWorkspacePromptContext
  /** When the workspace was recreated and its earlier files were lost. */
  readonly resetAt?: string
}

/**
 * How one run obtains its sandbox and gives it back. Every run kind goes through this lifecycle,
 * with one of two behaviors:
 *
 * - ephemeral (`ephemeralRunSandbox`): created for this run, blank or prepared from a recipe, and
 *   destroyed when the run releases it;
 * - persistent (`persistentRunSandbox`): a thread's workspace, resumed for this run and saved by
 *   `beforeFinalize`. It has no `release`: only a sub-agent run that ends without pausing
 *   destroys it.
 *
 * Acquisition may happen before `acquire()`: a thread's workspace is acquired before compaction,
 * so `acquire()` only hands it over. Preservation belongs to `beforeFinalize`, never `release`.
 */
export interface RunSandbox {
  /**
   * Whether the first model call waits for acquisition. A workspace the prompt describes must
   * exist first; a blank sandbox boots concurrently and tools wait for it only when used.
   */
  readonly waitBeforeModel: boolean
  /**
   * Where the run's files go, known before acquisition so the prompt can name them. As the agent
   * names it: relative to the working directory, or absolute.
   */
  readonly contextDirectory: string
  /**
   * The background commands the run's tools start and see, when they outlive the run: a
   * computer's thread keeps them across its turns, and its runner stops them. Absent, the run has
   * its own, stopped as it ends.
   */
  readonly background?: BackgroundCommands
  /**
   * The network policy the project declared for the sandbox, which `web_fetch` follows: only the
   * origins a `restricted` one lists, and no tool for `none`. Absent, as for a blank sandbox: any
   * URL.
   */
  readonly networkPolicy?: SandboxNetworkPolicy
  /** Where `web_fetch` reads pages from. Absent: Sixb's servers. */
  readonly webNetwork?: WebFetchNetwork
  /** Called once, when the run environment starts. */
  acquire(): Promise<AcquiredRunSandbox>
  /**
   * Give back an acquired sandbox, after the run or a failed provisioning. Absent when the run
   * has nothing to give back, so teardown never waits on it.
   */
  release?(acquired: AcquiredRunSandbox): Promise<void>
  /** Confirm preservation before the run's terminal write. Idempotent: the first call decides. */
  beforeFinalize?(options?: BeforeFinalizeOptions): Promise<void>
}

/** How a run's end leaves its thread's workspace. */
export interface BeforeFinalizeOptions {
  /**
   * The run leaves nothing its thread goes on from, as a sub-agent run that answered, failed or
   * was stopped: destroy its workspace instead of saving it.
   */
  readonly discard?: boolean
}

/**
 * Acquire a run's sandbox. A workspace the prompt describes comes with the instruction files it
 * carries, read once here: every request of the run then renders the same prompt, and so does the
 * next run while the files stay as they are.
 */
export async function acquireRunSandbox(
  sandbox: RunSandbox,
  signal?: AbortSignal
): Promise<AcquiredRunSandbox> {
  const acquired = await sandbox.acquire()
  const { promptContext } = acquired
  if (!sandbox.waitBeforeModel || !promptContext) return acquired

  const instructions = await readWorkspaceInstructions(
    acquired.sandbox,
    promptContext.workingDirectory,
    signal
  )
  if (instructions.length === 0) return acquired

  return { ...acquired, promptContext: { ...promptContext, instructions } }
}

/**
 * The run's sandbox, which calls `onStopped` each time a command or a file write finds that its
 * provider stopped it, such as at the end of a Vercel session. Whichever tool met it, nothing more
 * runs in it: the run ends instead of the model retrying there.
 */
export function endsWhenStopped(
  session: Sandbox,
  onStopped: (error: SandboxNotRunningError) => void
): Sandbox {
  // Watched beside its caller, which gets the provider's own promise: its wait gains no step, and
  // the run has ended before the caller reads the failure.
  const watch = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operation()
    result.catch((error: unknown) => {
      if (error instanceof SandboxNotRunningError) onStopped(error)
    })
    return result
  }

  return {
    id: session.id,
    provider: session.provider,
    get status() {
      return session.status
    },
    workingDirectory: session.workingDirectory,
    ...(session.setRequestCredentials
      ? { setRequestCredentials: session.setRequestCredentials.bind(session) }
      : {}),
    ...(session.credentialedUrl ? { credentialedUrl: session.credentialedUrl.bind(session) } : {}),
    runCommand: (command, args, options) => watch(() => session.runCommand(command, args, options)),
    writeFiles: (files) => watch(() => session.writeFiles(files)),
    stop: () => session.stop(),
    destroy: () => session.destroy(),
  }
}

const stops = new WeakMap<Error, SandboxNotRunningError>()

/** Why a run whose sandbox stopped ended, in the words its run and its reader see. */
export function sandboxStoppedError(cause: SandboxNotRunningError, message: string): Error {
  const error = withFailureMessage(
    createSixbError(
      "agent.execution_failed",
      "[SixbAgent] The run's sandbox stopped; nothing more can run in it.",
      { cause }
    ),
    message
  )
  stops.set(error, cause)
  return error
}

/** The provider's stop a run ended on, when `sandboxStoppedError` says that is why it ended. */
export function sandboxStopOf(error: unknown): SandboxNotRunningError | undefined {
  return error instanceof Error ? stops.get(error) : undefined
}
