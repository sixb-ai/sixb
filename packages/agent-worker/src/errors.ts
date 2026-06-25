/** Infra-level failure in the agent worker (unknown agent, missing storage, malformed job). */
export class AgentWorkerError extends Error {
  readonly name = "AgentWorkerError"
  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbAgentWorker] ${message}`, options)
  }
}

/**
 * The thread's active run is still held by a live worker (its `agent_runs` lease has not expired),
 * so this delivery cannot take it over yet. The worker retries the job at {@link availableAt}.
 */
export class AgentLeaseHeldError extends Error {
  readonly name = "AgentLeaseHeldError"
  constructor(
    readonly availableAt: string,
    message: string
  ) {
    super(`[SixbAgentWorker] ${message}`)
  }
}

/**
 * This worker lost the run's lease mid-turn (it was reclaimed by another worker after a crash was
 * suspected). The run now belongs to someone else, so this worker writes nothing further and simply
 * acknowledges its — now duplicate — delivery.
 */
export class AgentLeaseLostError extends Error {
  readonly name = "AgentLeaseLostError"
  constructor(readonly runId: string) {
    super(`[SixbAgentWorker] Lost the lease on agent run '${runId}'; another worker owns it.`)
  }
}

/**
 * Recording a run's terminal state failed on a non-terminal (infra) error that persisted across
 * in-place retries. The run is still `running` and its thread is still locked, so the worker must
 * **not** acknowledge the job: it lets the queue redeliver it, so a later delivery can finalize the
 * run once storage recovers. Distinct from {@link AgentLeaseLostError} (run no longer ours → ack).
 */
export class AgentFinalizationError extends Error {
  readonly name = "AgentFinalizationError"
  constructor(
    readonly runId: string,
    options?: ErrorOptions
  ) {
    super(
      `[SixbAgentWorker] Could not finalize agent run '${runId}'; storage is unavailable.`,
      options
    )
  }
}

/**
 * A turn exceeded its wall-clock budget. Unlike a shutdown abort, this is a run-level failure: the
 * run is recorded `failed` and the thread released (a slow-but-alive model must not hold a thread
 * forever). The name is intentionally **not** `AbortError`, so it routes through the normal failure
 * path rather than the worker's shutdown-abort path.
 */
export class AgentTurnTimeoutError extends Error {
  readonly name = "AgentTurnTimeoutError"
  constructor(
    readonly runId: string,
    readonly timeoutMs: number
  ) {
    super(`[SixbAgentWorker] Agent run '${runId}' exceeded its ${timeoutMs}ms turn budget.`)
  }
}
