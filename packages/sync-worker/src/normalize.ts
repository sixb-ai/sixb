import type { DatasetRow, SyncReadResult } from "@sixb/core"

function isPlainObject(value: unknown): value is DatasetRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
  )
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  )
}

function toAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }

  const message =
    typeof signal.reason === "string" && signal.reason.length > 0
      ? signal.reason
      : "[SixbSyncWorker] Operation was cancelled."

  const error = new Error(message)
  error.name = "AbortError"
  return error
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw toAbortError(signal)
  }
}

export function assertDatasetRow(value: unknown, syncId: string, itemIndex: number): DatasetRow {
  if (isPlainObject(value)) {
    return value
  }

  throw new Error(
    `[SixbSyncWorker] Sync '${syncId}' returned an invalid row at item ${itemIndex}. Dataset rows must be plain objects.`
  )
}

export async function* normalizeReadResult(
  readResult: SyncReadResult,
  syncId: string
): AsyncIterable<unknown> {
  if (isAsyncIterable(readResult)) {
    yield* readResult
    return
  }

  if (isIterable(readResult)) {
    for (const item of readResult) {
      yield item
    }
    return
  }

  if (isPlainObject(readResult)) {
    yield readResult
    return
  }

  throw new Error(
    `[SixbSyncWorker] Sync '${syncId}' returned an unsupported read result. Expected a row object, iterable, or async iterable.`
  )
}
