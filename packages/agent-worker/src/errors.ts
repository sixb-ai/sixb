import { AgentToolPublicError } from "@sixb/core"

/** Infra-level failure in the agent worker (unknown agent, missing storage, malformed job). */
export class AgentWorkerError extends Error {
  readonly name = "AgentWorkerError"
  constructor(message: string, options?: ErrorOptions) {
    super(`[SixbAgentWorker] ${message}`, options)
  }
}

/** This delivery's execution token is stale, so it must make no further durable writes. */
export class AgentExecutionLostError extends Error {
  readonly name = "AgentExecutionLostError"
  constructor(readonly runId: string) {
    super(`[SixbAgentWorker] Lost execution ownership of agent run '${runId}'.`)
  }
}

/**
 * Recording a run's terminal state failed on a non-terminal (infra) error that persisted across
 * in-place retries. The run is still `running` and its thread is still locked, so the worker must
 * **not** acknowledge the job: it lets the queue redeliver it, so a later delivery can finalize the
 * run once storage recovers. Distinct from {@link AgentExecutionLostError} (run no longer ours → ack).
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

/** Keep an untrusted tool failure as the cause while exposing only a generic message to AI SDK. */
export class AgentToolExecutionError extends Error {
  readonly name = "AgentToolExecutionError"

  constructor(
    readonly toolName: string,
    options: ErrorOptions
  ) {
    super("An error occurred.", options)
  }
}

/** A selected agent tool returned a value that cannot cross the durable JSON message boundary. */
export class AgentToolOutputError extends AgentToolPublicError {
  override readonly name = "AgentToolOutputError"
  constructor(
    readonly toolName: string,
    reason: string,
    options?: ErrorOptions
  ) {
    super(
      `[SixbAgentWorker] Agent tool '${toolName}' returned a non-JSON result; ${reason}.`,
      options
    )
  }
}
