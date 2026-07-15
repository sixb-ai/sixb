import { WorkerAbortError } from "@sixb/core/internal/workers"
import type { ActionRunFailure } from "@sixb/core/storage"

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new WorkerAbortError("Action worker aborted.")
  }
}

export function toActionRunFailure(
  error: unknown,
  phase: ActionRunFailure["phase"]
): ActionRunFailure {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      phase,
    }
  }

  return {
    message: String(error),
    phase,
  }
}
