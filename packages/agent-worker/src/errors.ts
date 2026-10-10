import { AgentToolPublicError } from "@sixb/core"
import type { AgentCompactionFailureCode } from "@sixb/core/agents/streams"

/** Failed preservation is a failure even when the run was also cancelled. */
export class AgentEnvironmentSaveError extends Error {
  readonly name = "AgentEnvironmentSaveError"

  constructor() {
    super("[SixbAgentWorker] Sandbox save or cleanup could not be confirmed. Recovery is required.")
  }
}

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
 * A workflow agent node succeeded but its workflow resume could not be queued. The worker leaves
 * the node's job unacknowledged: a redelivery finds the node succeeded and only re-sends the resume.
 */
export class WorkflowResumeDispatchError extends Error {
  readonly name = "WorkflowResumeDispatchError"
  constructor(
    readonly nodeRunId: string,
    options?: ErrorOptions
  ) {
    super(
      `[SixbAgentWorker] Could not queue the workflow resume after agent node '${nodeRunId}'.`,
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

/**
 * The worker running a conversation turn stopped, or died, before finishing it. The turn is
 * recorded `cancelled` with `finishReason: "interrupted"` rather than replayed: the user already saw
 * it stream and its model calls were billed, so resuming it is their call.
 */
export class AgentTurnInterruptedError extends Error {
  readonly name = "AgentTurnInterruptedError"
  constructor(readonly runId: string) {
    super(
      `[SixbAgentWorker] Agent run '${runId}' was interrupted when the worker running it stopped.`
    )
  }
}

/**
 * A redelivered job found its run still owned by a live delivery: a duplicate job. The worker
 * leaves the run alone and retries the job once that delivery's projected lease lapses.
 */
export class AgentRunOwnedElsewhereError extends Error {
  readonly name = "AgentRunOwnedElsewhereError"
  constructor(
    readonly runId: string,
    readonly ownedUntil: Date
  ) {
    super(`[SixbAgentWorker] Agent run '${runId}' is still owned by another delivery.`)
  }
}

/** Keep an untrusted tool failure as the cause while exposing only a generic message to the model. */
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
