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
      cause: error,
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
