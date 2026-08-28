import { AgentToolPublicError } from "@sixb/core"
import type { AgentCompactionFailureCode } from "@sixb/core/agents/streams"

/** A thread could not complete its required preflight compaction. */
export class AgentContextCompactionError extends Error {
  readonly name = "AgentContextCompactionError"

  constructor(
    readonly code: AgentCompactionFailureCode,
    readonly runId: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(`[SixbAgentWorker] ${message}`, options)
  }
}

/** A completed provider call was not recorded synchronously, so this turn must stop. */
export class AgentUsageRecordingError extends Error {
  readonly name = "AgentUsageRecordingError"

  constructor(
    readonly runId: string,
    readonly callId: string,
    readonly recoveryScheduled: boolean,
    options?: ErrorOptions
  ) {
    super(
      recoveryScheduled
        ? `[SixbAgentWorker] AI usage for call '${callId}' in agent execution '${runId}' was deferred to durable recovery.`
        : `[SixbAgentWorker] Could not preserve AI usage for call '${callId}' in agent execution '${runId}'.`,
      options
    )
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
 * Recording an agent execution's terminal state failed on a non-terminal infrastructure error that
 * persisted across in-place retries. The execution is still running, so the worker must **not**
 * acknowledge the job: it lets the queue redeliver it, so a later delivery can finalize once
 * storage recovers. Distinct from {@link AgentExecutionLostError} (run no longer ours → ack).
 */
export class AgentFinalizationError extends Error {
  readonly name = "AgentFinalizationError"
  constructor(
    readonly runId: string,
    options?: ErrorOptions
  ) {
    super(
      `[SixbAgentWorker] Could not finalize agent execution '${runId}'; storage is unavailable.`,
      options
    )
  }
}

/**
 * A turn exceeded its wall-clock budget. Unlike a shutdown abort, this is a run-level failure: the
 * run is recorded `failed` and the thread released (a slow-but-alive model must not hold a thread
 * forever). It is persisted as the run failure while coherent partial work is retained as the
 * assistant message.
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

/** A selected agent tool returned a value that cannot cross the durable message boundary. */
export class AgentToolOutputError extends AgentToolPublicError {
  override readonly name = "AgentToolOutputError"
  constructor(
    readonly toolName: string,
    reason: string,
    options?: ErrorOptions
  ) {
    super(
      `[SixbAgentWorker] Agent tool '${toolName}' returned an invalid result; ${reason}.`,
      options
    )
  }
}
