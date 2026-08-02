import type { WorkflowRunStatus } from "@sixb/core/storage"
import { type SixbFailure, toSixbFailure } from "@sixb/core/storage"

export function createAbortError(): Error {
  const error = new Error("Workflow worker aborted.")
  error.name = "AbortError"
  return error
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError()
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

export function statusForFailure(
  signal: AbortSignal,
  error: unknown
): Extract<WorkflowRunStatus, "failed" | "cancelled"> {
  return signal.aborted || isAbortError(error) ? "cancelled" : "failed"
}

/**
 * Files an unlabeled workflow failure under the workflow's own code rather than the catch-all, and
 * under the cancellation code when that is what the status says — a cancelled run whose record reads
 * `workflow.failed` contradicts itself.
 */
export function toWorkflowRunError(
  error: unknown,
  status: Extract<WorkflowRunStatus, "failed" | "cancelled"> = "failed"
): SixbFailure {
  return toSixbFailure(error, {
    fallbackCode: status === "cancelled" ? "runtime.cancelled" : "workflow.failed",
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
