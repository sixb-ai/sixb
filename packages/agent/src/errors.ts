import { AgentToolPublicError } from "@sixb/core"
import type { AgentCompactionFailureCode } from "@sixb/core/agents/streams"
import { AgentExecutionLostError } from "@sixb/core/internal/agents"
import { QueueDeliveryLeaseLostError } from "@sixb/core/internal/workers"

/** A thread could not complete its required preflight compaction. */
export class AgentContextCompactionError extends Error {
  readonly name = "AgentContextCompactionError"

  constructor(
    readonly code: AgentCompactionFailureCode,
    readonly runId: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(`[SixbAgent] ${message}`, options)
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
      `[SixbAgent] Agent run '${runId}' was cancelled: whoever asked for it no longer takes part in its thread.`
    )
  }
}

/**
 * Whether this delivery lost its run: its execution token, or its queue lease, which `signal` (the
 * delivery's) may carry. The current owner records the run's fate; this delivery touches nothing.
 */
export function isLostExecution(error: unknown, signal?: AbortSignal): boolean {
  return isLostExecutionReason(error) || isLostExecutionReason(signal?.reason)
}

/**
 * Throw why a runner lost its run, if that is why `signal` aborted: its execution token went to
 * another runner, or a queue took back its delivery.
 */
export function throwIfExecutionLost(signal: AbortSignal): void {
  if (isLostExecutionReason(signal.reason)) throw signal.reason
}

function isLostExecutionReason(reason: unknown): boolean {
  return reason instanceof AgentExecutionLostError || reason instanceof QueueDeliveryLeaseLostError
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
    super(`[SixbAgent] Agent tool '${toolName}' returned an invalid result; ${reason}.`, options)
  }
}

/** Failed preservation is a failure even when the run was also cancelled. */
export class AgentEnvironmentSaveError extends Error {
  readonly name = "AgentEnvironmentSaveError"

  constructor() {
    super("[SixbAgent] Sandbox save or cleanup could not be confirmed. Recovery is required.")
  }
}
