import { parseActionRunFailure } from "@sixb/core/internal/action-run-storage"
import {
  createSixbError,
  isSixbError,
  summarizeErrorMessage,
  toSixbFailure,
} from "@sixb/core/internal/errors"
import { WorkerAbortError } from "@sixb/core/internal/workers"
import {
  ACTION_RUN_FAILURE_CODES,
  type ActionRunFailure,
  type ActionRunPhase,
} from "@sixb/core/storage"

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new WorkerAbortError("Action worker aborted.")
  }
}

/** Translate work performed by an Action phase without misclassifying its bookkeeping. */
export function translateActionPhaseError(
  error: unknown,
  phase: Exclude<ActionRunPhase, "request" | "enqueue" | "cancelled">,
  input: {
    readonly actionId: string
    readonly runId: string
    readonly signal: AbortSignal
  }
): unknown {
  if (input.signal.aborted || (isSixbError(error) && error.code === "internal.unexpected")) {
    return error
  }

  return createSixbError(
    "action.phase_failed",
    summarizeErrorMessage(error, "Action phase execution failed."),
    {
      cause: error,
      details: {
        actionId: input.actionId,
        runId: input.runId,
        phase,
      },
    }
  )
}

/** Recover the native phase error for direct callers and error-monitoring integrations. */
export function unwrapActionPhaseError(error: unknown): unknown {
  return isSixbError(error) && error.code === "action.phase_failed" && error.cause !== undefined
    ? error.cause
    : error
}

export function toActionRunFailure<TPhase extends ActionRunPhase>(
  error: unknown,
  phase: TPhase,
  input: {
    readonly actionId: string
    readonly runId: string
    readonly at: Date
  }
): ActionRunFailure<TPhase> {
  const code =
    isSixbError(error) && (ACTION_RUN_FAILURE_CODES as readonly string[]).includes(error.code)
      ? (error.code as ActionRunFailure<TPhase>["code"])
      : phase === "cancelled"
        ? "runtime.cancelled"
        : "internal.unexpected"
  const normalized = createSixbError(
    code,
    summarizeErrorMessage(error, "Action execution failed."),
    {
      cause: unwrapActionPhaseError(error),
      details: {
        actionId: input.actionId,
        runId: input.runId,
        phase,
      },
    }
  )

  return parseActionRunFailure(
    toSixbFailure(normalized, {
      allowedCodes: ACTION_RUN_FAILURE_CODES,
      at: input.at,
    }),
    phase
  )
}
