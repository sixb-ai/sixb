import type { WorkflowRunStatus } from "@pario/core"

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

export function toWorkflowRunError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
