import {
  createSixbError,
  isSixbError,
  type SixbCodedError,
  summarizeErrorMessage,
  toSixbFailure,
} from "../../errors/internal"
import { isMaterializationConflictError } from "../../materialization/errors"
import { ActionValidationError } from "../../objects/action/errors"
import { ACTION_RUN_FAILURE_CODES, type ActionRunFailure, type ActionRunPhase } from "../../storage"
import { parseActionRunFailure } from "../../storage/action-runs/failure"
import { isActionTimeout } from "./signals"

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("[Sixb] Action run was cancelled.", "AbortError")
}

/**
 * Wait for a handler until the signal of its phase aborts, then reject with the abort's reason.
 *
 * A handler stops early only when it forwards its `signal` to what it awaits. One that does not
 * keeps running after the abort, but the run no longer waits for it: nothing it does from then on
 * reaches the run, and what it throws is dropped.
 */
export async function untilAborted<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  const aborted = Promise.withResolvers<never>()
  const abort = () => aborted.reject(abortReason(signal))
  signal.addEventListener("abort", abort, { once: true })
  const running = (async () => work())()
  try {
    return await Promise.race([running, aborted.promise])
  } finally {
    signal.removeEventListener("abort", abort)
    running.catch(() => undefined)
  }
}

/**
 * Translate work performed by an Action phase without misclassifying its bookkeeping.
 *
 * Whatever a handler throws once its phase's signal aborted is that abort's doing: the run failed
 * with `action.timeout` when its deadline elapsed, and with `runtime.cancelled` when its caller
 * aborted. The handler's own error stays the cause reported to `onError`. Every expectation an
 * Action commit carries comes from the Action's own reads, so an expectation conflict at commit is
 * a read conflict: the run can be requested again against current state. A validator's returned
 * error is a rejection, not a crash.
 */
export function translateActionPhaseError(
  error: unknown,
  phase: ActionRunPhase,
  input: {
    readonly actionId: string
    readonly runId: string
    /** The signal the work ran under. Omit it for work that nothing interrupts, like a commit. */
    readonly signal?: AbortSignal
  }
): unknown {
  const details = { actionId: input.actionId, runId: input.runId, phase }
  if (input.signal?.aborted) {
    if (isActionTimeout(input.signal.reason)) {
      return isActionTimeout(error)
        ? error
        : createSixbError(
            "action.timeout",
            `[Sixb] Action run '${input.runId}' exceeded its deadline during ${phase}.`,
            { cause: error, details }
          )
    }
    return isSixbError(error) && error.code === "runtime.cancelled"
      ? error
      : createSixbError(
          "runtime.cancelled",
          `[Sixb] Action run '${input.runId}' was cancelled by its caller during ${phase}.`,
          { cause: error, details }
        )
  }
  if (isSixbError(error) && error.code === "internal.unexpected") {
    return error
  }
  if (error instanceof ActionValidationError) {
    return createSixbError("action.rejected", error.message, { cause: error, details })
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
    (error.code === "action.phase_failed" ||
      error.code === "action.read_conflict" ||
      error.code === "action.rejected")
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
