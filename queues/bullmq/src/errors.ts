import { QueueError } from "@sixb/core"

export { QueueError }

/**
 * Wraps a BullMQ lock/token rejection as a `QueueError`. BullMQ throws generic `Error`s with
 * messages like "Missing lock" or "Lock mismatch"; wrapping them as `QueueError` keeps the
 * adapter polymorphic with the in-memory provider and the shared contract suite, while
 * preserving the original via `cause` for debugging.
 */
export function wrapLeaseError(error: unknown, jobId: string): QueueError {
  if (error instanceof QueueError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new QueueError(`[Sixb] Lease mismatch or expired for queue job '${jobId}': ${message}`, {
    cause: error instanceof Error ? error : undefined,
  })
}
