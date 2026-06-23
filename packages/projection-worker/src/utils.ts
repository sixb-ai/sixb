import { type DatasetRow, type ProjectionRunCounters, zeroProjectionRunCounters } from "@sixb/core"

// A writable view of the canonical counter shape, derived so the field set
// stays in lockstep with ProjectionRunCounters.
export type MutableProjectionCounters = {
  -readonly [K in keyof ProjectionRunCounters]: ProjectionRunCounters[K]
}

export function createZeroCounters(): MutableProjectionCounters {
  return { ...zeroProjectionRunCounters() }
}

export function snapshotCounters(counters: MutableProjectionCounters): ProjectionRunCounters {
  return { ...counters }
}

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "")
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createAbortError(): Error {
  const error = new Error("Projection worker aborted.")
  error.name = "AbortError"
  return error
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError()
  }
}

// Narrows a raw value to a plain-object dataset row, rejecting class instances
// and arrays. Shared by the object and telemetry row projectors.
export function isPlainObject(value: unknown): value is DatasetRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
