import {
  createSixbError,
  isSixbError,
  type SixbCodedError,
  summarizeErrorMessage,
  toSixbFailure,
} from "../../errors/internal"
import { isMaterializationConflictError } from "../../materialization/errors"
import { ACTION_RUN_FAILURE_CODES, type ActionRunFailure, type ActionRunPhase } from "../../storage"
import { parseActionRunFailure } from "../../storage/action-runs/failure"
import { WorkerAbortError } from "../../workers/errors"
import { isActionTimeout } from "./signals"

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new WorkerAbortError("[Sixb] Action run was cancelled.")
  }
}

/**
 * Translate work performed by an Action phase without misclassifying its bookkeeping.
 *
 * Whatever a handler throws once its phase's deadline has elapsed is that deadline's doing: the run
 * failed with `action.timeout`, and the handler's own error stays the cause reported to `onError`.
 * Every expectation an Action commit carries comes from the Action's own reads, so an expectation
 * conflict at commit is a read conflict: the run can be requested again against current state.
 */
export function translateActionPhaseError(
  error: unknown,
  phase: Exclude<ActionRunPhase, "request" | "enqueue" | "cancelled">,
  input: {
    readonly actionId: string
    readonly runId: string
    /** The signal the work ran under. Omit it for work that nothing interrupts, like a commit. */
    readonly signal?: AbortSignal
  }
): unknown {
  const details = { actionId: input.actionId, runId: input.runId, phase }
  if (input.signal?.aborted) {
    return isActionTimeout(input.signal.reason) && !isActionTimeout(error)
      ? createSixbError(
          "action.timeout",
          `[Sixb] Action run '${input.runId}' exceeded its deadline during ${phase}.`,
          { cause: error, details }
        )
      : error
  }
  if (isSixbError(error) && error.code === "internal.unexpected") {
    return error
  }
  if (phase === "commit" && isMaterializationConflictError(error) && error.kind === "expectation") {
    return createSixbError("action.read_conflict", error.message, { cause: error, details })
  }

  return createSixbError(
    "action.phase_failed",
    summarizeErrorMessage(error, "Action phase execution failed."),
    { cause: error, details }
  )
}

/** Whether a phase classified this error as the phase's own failure, rather than as an abort. */
export function isActionPhaseFailure(error: unknown): error is SixbCodedError {
  return (
    isSixbError(error) &&
    (error.code === "action.phase_failed" || error.code === "action.read_conflict")
  )
}

/** Recover the native phase error for direct callers and error-monitoring integrations. */
export function unwrapActionPhaseError(error: unknown): unknown {
  return isActionPhaseFailure(error) && error.cause !== undefined ? error.cause : error
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
