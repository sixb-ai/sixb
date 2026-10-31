import { AgentToolPublicError, type Storage } from "@sixb/core"
import type { AgentCompactionFailureCode } from "@sixb/core/agents/streams"
import { AgentExecutionLostError } from "@sixb/core/internal/agents"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"

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

/**
 * Whoever asked for a queued turn no longer owns or takes part in its thread: they left it, or its
 * owner removed them. The turn ends cancelled without reaching the model.
 */
export class AgentRequesterLeftThreadError extends Error {
  readonly name = "AgentRequesterLeftThreadError"

  constructor(readonly runId: string) {
    super(
      `[SixbAgentWorker] Agent run '${runId}' was cancelled: whoever asked for it no longer takes part in its thread.`
    )
  }
}

/**
 * Whether this delivery lost its run: its execution token, or its queue lease, which `signal` (the
 * delivery's) may carry. The current owner records the run's fate; this delivery touches nothing.
 */
export function isLostExecution(error: unknown, signal?: AbortSignal): boolean {
  return (
    error instanceof AgentExecutionLostError ||
    error instanceof QueueDeliveryLeaseLostError ||
    signal?.reason instanceof QueueDeliveryLeaseLostError
  )
}

/** A durable run, or workflow node run, as an ownership fence reads it. */
interface FencedRun {
  readonly status: string
  readonly execution?: { readonly token: string; readonly queueLeaseExpiresAt: Date }
}

/**
 * Throws {@link AgentExecutionLostError} unless `current` is still running under this delivery's
 * execution token, within its queue lease. Read `current` from storage right before the action it
 * fences; never trust guest metadata.
 */
export function assertExecutionOwned(fence: {
  readonly current: FencedRun | null | undefined
  readonly executionToken: string
  readonly runId: string
}): void {
  const { current, executionToken, runId } = fence

  if (
    current?.status !== "running" ||
    current.execution?.token !== executionToken ||
    current.execution.queueLeaseExpiresAt.getTime() <= Date.now()
  ) {
    throw new AgentExecutionLostError(runId)
  }
}

/**
 * {@link assertExecutionOwned} for a conversation run. `storage` may be a transaction, so the
 * check and the write it guards commit together.
 */
export async function assertRunExecutionOwned(
  storage: Storage,
  run: { readonly projectId: string; readonly id: string; readonly executionToken: string }
): Promise<void> {
  const current = await storage.agents?.runs.getById({ projectId: run.projectId, id: run.id })

  assertExecutionOwned({ current, executionToken: run.executionToken, runId: run.id })
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
