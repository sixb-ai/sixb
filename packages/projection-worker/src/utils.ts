import { type ProjectionRunCounters, zeroProjectionRunCounters } from "@sixb/core"

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
