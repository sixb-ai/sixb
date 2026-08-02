import { SixbError, type SixbErrorOptions, SixbTimeoutError } from "@sixb/core/errors"

/** Infra-level failure in the agent worker (unknown agent, missing storage, malformed job). */
export class AgentWorkerError extends SixbError {
  override readonly name = "AgentWorkerError"

  constructor(message: string, options?: SixbErrorOptions) {
    super("agent.failed", `[SixbAgentWorker] ${message}`, options)
  }
}

/** This delivery's execution token is stale, so it must make no further durable writes. */
export class AgentExecutionLostError extends SixbError {
  override readonly name = "AgentExecutionLostError"

  constructor(readonly runId: string) {
    super(
      "agent.execution_lost",
      `[SixbAgentWorker] Lost execution ownership of agent run '${runId}'.`,
      {
        details: { runId },
      }
    )
  }
}

/**
 * Recording a run's terminal state failed on a non-terminal (infra) error that persisted across
 * in-place retries. The run is still `running` and its thread is still locked, so the worker must
 * **not** acknowledge the job: it lets the queue redeliver it, so a later delivery can finalize the
 * run once storage recovers. Distinct from {@link AgentExecutionLostError} (run no longer ours → ack).
 */
export class AgentFinalizationError extends SixbError {
  override readonly name = "AgentFinalizationError"

  constructor(
    readonly runId: string,
    options: SixbErrorOptions = {}
  ) {
    super(
      "storage.unavailable",
      `[SixbAgentWorker] Could not finalize agent run '${runId}'; storage is unavailable.`,
      { ...options, details: { runId, ...options.details } }
    )
  }
}

/**
 * A turn exceeded its wall-clock budget. Unlike a shutdown abort, this is a run-level failure: the
 * run is recorded `failed` and the thread released (a slow-but-alive model must not hold a thread
 * forever). The name is intentionally **not** `AbortError`, so it routes through the normal failure
 * path rather than the worker's shutdown-abort path.
 */
export class AgentTurnTimeoutError extends SixbTimeoutError {
  override readonly name = "AgentTurnTimeoutError"

  constructor(
    readonly runId: string,
    readonly timeoutMs: number
  ) {
    super(
      "agent.timed_out",
      `[SixbAgentWorker] Agent run '${runId}' exceeded its ${timeoutMs}ms turn budget.`,
      { details: { runId, timeoutMs } }
    )
  }
}
