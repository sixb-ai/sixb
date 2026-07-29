import type { DatasetRow } from "@sixb/core"

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "")
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Propagates QueueDelivery's exact abort reason; liveness policy depends on its identity. */
export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason ?? createAbortError()
}

export function createAbortError(): Error {
  const error = new Error("Projection worker aborted.")
  error.name = "AbortError"
  return error
}

export function isPlainObject(value: unknown): value is DatasetRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
