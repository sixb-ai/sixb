import type { Storage } from "@sixb/core"
import type {
  AgentRunRecord,
  AgentStorage,
  AppendAgentMessageInput,
  FinishAgentRunInput,
} from "@sixb/core/storage"
import { AgentStorageError } from "@sixb/core/storage"
import { AgentExecutionLostError, AgentFinalizationError } from "./errors"
import { type AgentRunFailure, toAgentExecutionFailure } from "./failure"

/** Short in-place retries that absorb a transient storage blip without re-running the model. */
const FINALIZE_BACKOFF_MS = [50, 200, 600] as const

/**
 * Terminal storage outcomes that mean "this run is no longer ours / already finalized". On any of
 * these the worker stops touching the run: another worker owns it, or it is already in a terminal
 * state — nothing more to record either way.
 */
export function isTerminalOrExecutionGone(error: unknown): boolean {
  return (
    error instanceof AgentStorageError &&
    (error.code === "execution_lost" ||
      error.code === "invalid_state" ||
      error.code === "run_not_found")
  )
}

/**
 * Finalize a run, absorbing transient infra blips with a few short in-place retries.
 *
 * - returns the finalized record on success;
 * - throws {@link AgentExecutionLostError} if the run is no longer ours (token stale / already terminal),
 *   so the caller acknowledges the (now duplicate) delivery;
 * - throws {@link AgentFinalizationError} if a non-terminal (infra) error persists across retries,
 *   so the caller leaves the job for redelivery instead of acking a still-locked thread.
 */
export async function finishRunOrThrow(
  storage: AgentStorage,
  input: FinishAgentRunInput
): Promise<AgentRunRecord> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await storage.runs.finish(input)
    } catch (error) {
      await waitBeforeFinalizeRetry(input.id, attempt, error)
    }
  }
}

export async function appendMessageAndFinishRunOrThrow(
  storage: Storage,
  input: {
    readonly message: AppendAgentMessageInput
    readonly finish: FinishAgentRunInput
  }
): Promise<AgentRunRecord> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await storage.transaction(async (tx) => {
        const agents = tx.agents
        if (!agents) {
          throw new Error("[SixbAgentWorker] Agent storage is not configured.")
        }
        await agents.messages.append(input.message)
        return agents.runs.finish(input.finish)
      })
    } catch (error) {
      await waitBeforeFinalizeRetry(input.finish.id, attempt, error)
    }
  }
}

async function waitBeforeFinalizeRetry(
  runId: string,
  attempt: number,
  error: unknown
): Promise<void> {
  if (isTerminalOrExecutionGone(error)) {
    throw new AgentExecutionLostError(runId)
  }
  const delay = FINALIZE_BACKOFF_MS[attempt]
  if (delay === undefined) {
    throw new AgentFinalizationError(runId, { cause: error })
  }
  await sleep(delay)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Diagnostic details stamped onto every Agent run failure. */
export function agentRunFailureDetails(
  run: Pick<AgentRunRecord, "id" | "agentId" | "threadId">
): Readonly<Record<string, string>> {
  return { agentId: run.agentId, runId: run.id, threadId: run.threadId }
}

/**
 * Record a run's terminal fate, shared by the queued path and by in-process sub-agent runs.
 *
 * Returns `undefined` when the run is already terminal or no longer ours — nothing left to record.
 * A persistent storage failure raises {@link AgentFinalizationError}: the queued caller leaves its
 * job for redelivery, and the sub-agent caller propagates so the delegating turn fails rather than
 * reporting a lost child as a success.
 */
export async function recordAgentRunFate(input: {
  readonly storage: AgentStorage
  readonly projectId: string
  readonly run: AgentRunRecord
  readonly executionToken: string
  readonly status: "failed" | "cancelled"
  readonly error: unknown
}): Promise<{ readonly run: AgentRunRecord; readonly failure: AgentRunFailure } | undefined> {
  try {
    const completedAt = new Date()
    const failure = toAgentExecutionFailure(input.error, {
      status: input.status,
      at: completedAt,
      details: agentRunFailureDetails(input.run),
    })
    const finalized = await finishRunOrThrow(input.storage, {
      projectId: input.projectId,
      id: input.run.id,
      executionToken: input.executionToken,
      status: input.status,
      error: failure,
      completedAt,
    })
    return { run: finalized, failure }
  } catch (finalizeError) {
    if (finalizeError instanceof AgentExecutionLostError) {
      return undefined
    }
    throw finalizeError
  }
}
