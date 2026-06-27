import type { AgentRunRecord, AgentStorage } from "@sixb/core"
import { AgentStorageError } from "@sixb/core"
import { AgentFinalizationError, AgentLeaseLostError } from "./errors"

/** Short in-place retries that absorb a transient storage blip without re-running the model. */
const FINALIZE_BACKOFF_MS = [50, 200, 600] as const

/**
 * Terminal storage outcomes that mean "this run is no longer ours / already finalized". On any of
 * these the worker stops touching the run: another worker owns it, or it is already in a terminal
 * state — nothing more to record either way.
 */
export function isTerminalOrLeaseGone(error: unknown): boolean {
  return (
    error instanceof AgentStorageError &&
    (error.code === "lease_lost" ||
      error.code === "invalid_state" ||
      error.code === "run_not_found")
  )
}

/**
 * Finalize a run, absorbing transient infra blips with a few short in-place retries.
 *
 * - returns the finalized record on success;
 * - throws {@link AgentLeaseLostError} if the run is no longer ours (lease gone / already terminal),
 *   so the caller acknowledges the (now duplicate) delivery;
 * - throws {@link AgentFinalizationError} if a non-terminal (infra) error persists across retries,
 *   so the caller leaves the job for redelivery instead of acking a still-locked thread.
 */
export async function finishRunOrThrow(
  storage: AgentStorage,
  input: Parameters<AgentStorage["runs"]["finish"]>[0],
  runId: string
): Promise<AgentRunRecord> {
  let lastError: unknown
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await storage.runs.finish(input)
    } catch (error) {
      if (isTerminalOrLeaseGone(error)) {
        throw new AgentLeaseLostError(runId)
      }
      lastError = error
      const delay = FINALIZE_BACKOFF_MS[attempt]
      if (delay === undefined) {
        throw new AgentFinalizationError(runId, { cause: lastError })
      }
      await sleep(delay)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
