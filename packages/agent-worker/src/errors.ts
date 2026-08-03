import { isSixbError, SixbError, type SixbErrorOptions, toSixbFailure } from "@sixb/core/errors"

const FINALIZATION_REASON = "agent_finalization_failed"

/**
 * An infra-level failure in the agent worker (unknown agent, missing storage, malformed job).
 * Always `agent.failed`, which `onExecutionError` reads to fail the delivery outright.
 */
export function agentWorkerError(message: string, options?: SixbErrorOptions): SixbError {
  return new SixbError("agent.failed", `[SixbAgentWorker] ${message}`, options)
}

/**
 * This delivery's execution token is stale, so it must make no further durable writes.
 *
 * `agent.execution_lost` is also what the agent store raises when a write loses the token race, and
 * that is the same event one layer down: a reader at either layer wants to touch nothing and let the
 * current delivery reconcile the run.
 */
export function agentExecutionLost(runId: string): SixbError {
  return new SixbError(
    "agent.execution_lost",
    `[SixbAgentWorker] Lost execution ownership of agent run '${runId}'.`,
    { details: { runId } }
  )
}

/**
 * Recording a run's terminal state failed on a non-terminal (infra) error that persisted across
 * in-place retries. The run is still `running` and its thread is still locked, so the worker must
 * **not** acknowledge the job: it lets the queue redeliver it, so a later delivery can finalize the
 * run once storage recovers. Distinct from {@link agentExecutionLost} (run no longer ours → ack).
 */
export function agentFinalizationFailure(runId: string, options: SixbErrorOptions = {}): SixbError {
  return new SixbError(
    "storage.unavailable",
    `[SixbAgentWorker] Could not finalize agent run '${runId}'; storage is unavailable.`,
    { ...options, details: { runId, reason: FINALIZATION_REASON, ...options.details } }
  )
}

/**
 * Whether a failure is the one {@link agentFinalizationFailure} raises.
 *
 * The code alone will not do. `storage.unavailable` is also what the agent store, the auth store and
 * `requestAgentRun` raise, and those happen *before* the turn starts — routing one of them as a
 * failed finalize would leave the worker redelivering a job whose run never ran. Hence the reason in
 * `details`, which is what actually distinguishes the two.
 */
export function isAgentFinalizationFailure(error: unknown): boolean {
  return (
    isSixbError(error, "storage.unavailable") &&
    toSixbFailure(error).details?.reason === FINALIZATION_REASON
  )
}

/**
 * A turn exceeded its wall-clock budget. Unlike a shutdown abort, this is a run-level failure: the
 * run is recorded `failed` and the thread released (a slow-but-alive model must not hold a thread
 * forever). The name stays the default and is intentionally **not** `AbortError`, so it routes
 * through the normal failure path rather than the worker's shutdown-abort path.
 */
export function agentTurnTimeout(runId: string, timeoutMs: number): SixbError {
  return new SixbError(
    "agent.timed_out",
    `[SixbAgentWorker] Agent run '${runId}' exceeded its ${timeoutMs}ms turn budget.`,
    { details: { runId, timeoutMs } }
  )
}
