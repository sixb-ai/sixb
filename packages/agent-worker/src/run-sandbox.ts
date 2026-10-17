import type { AgentWorkspacePromptContext } from "./agent-prompt"
import type { AgentSandboxHandle } from "./sandbox-handle"

/** The sandbox a run works in, with what the system prompt may say about it. */
export interface AcquiredRunSandbox extends AgentSandboxHandle {
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
 *   `beforeFinalize`. It has no `release`: nothing destroys it.
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
  /** Called once, when the run environment starts. */
  acquire(): Promise<AcquiredRunSandbox>
  /**
   * Give back an acquired sandbox, after the run or a failed provisioning. Absent when the run
   * has nothing to give back, so teardown never waits on it.
   */
  release?(acquired: AgentSandboxHandle): Promise<void>
  /** Confirm preservation before the run's terminal write. Idempotent. */
  beforeFinalize?(): Promise<void>
}
