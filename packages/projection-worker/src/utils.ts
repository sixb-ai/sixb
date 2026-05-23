import type { ProjectionRunCounters } from "@sixb/core"

export type MutableProjectionCounters = {
  rowsProcessed: number
  rowsSkipped: number
  objectsUpserted: number
  linksUpserted: number
}

export function createZeroCounters(): MutableProjectionCounters {
  return {
    rowsProcessed: 0,
    rowsSkipped: 0,
    objectsUpserted: 0,
    linksUpserted: 0,
  }
}

export function snapshotCounters(counters: MutableProjectionCounters): ProjectionRunCounters {
  return {
    rowsProcessed: counters.rowsProcessed,
    rowsSkipped: counters.rowsSkipped,
    objectsUpserted: counters.objectsUpserted,
    linksUpserted: counters.linksUpserted,
  }
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
