import { toSixbFailure } from "@sixb/core/internal/errors"
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

export function toActionRunFailure<TPhase extends ActionRunPhase>(
  error: unknown,
  phase: TPhase,
  input: {
    readonly actionId: string
    readonly runId: string
    readonly at: Date
  }
): ActionRunFailure<TPhase> {
  return {
    ...toSixbFailure(error, {
      allowedCodes: ACTION_RUN_FAILURE_CODES,
      fallbackCode: phase === "cancelled" ? "runtime.cancelled" : "internal.unexpected",
      at: input.at,
      fallbackDetails: {
        actionId: input.actionId,
        runId: input.runId,
      },
    }),
    phase,
  }
}
