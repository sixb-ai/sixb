import { WorkerAbortError } from "@sixb/core/internal/workers"

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new WorkerAbortError("Action worker aborted.")
  }
}
