import { SixbError } from "@sixb/core/errors"

const PROVIDER = "@sixb/queues-bullmq"

/**
 * Wraps a BullMQ/ioredis rejection as `queue.unavailable`.
 *
 * A third party never strikes a Sixb code. Left raw, a Redis outage is read downstream as whatever
 * the caller happened to be doing: a failed enqueue was filed as `action.failed` on the run row and
 * answered `400`, because the route's fallback for an unrecognized throw is `runtime.invalid_input`.
 * Normalizing here is what makes the same outage `queue.unavailable` on the run row, in `onError`,
 * and as `503`.
 *
 * One code for every driver rejection, not a taxonomy: this adapter cannot tell a refused
 * connection from a BullMQ command failure, and the caller's question is the same either way — the
 * queue did not take the work. The original is kept on `cause`, which is where the difference lives.
 */
export function wrapDriverError(error: unknown, operation: string): SixbError {
  // Identity, not meaning: an error this adapter already raised (a closed provider, a lease
  // mismatch, a rejected argument) keeps the code it was given. The result is thrown, so it has to
  // be a live error and not merely something code-shaped.
  if (error instanceof SixbError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new SixbError("queue.unavailable", `[Sixb] Queue ${operation} failed: ${message}`, {
    details: { provider: PROVIDER, operation },
    cause: error,
  })
}

/**
 * Wraps a BullMQ lock/token rejection as `runtime.invalid_input`. BullMQ throws generic `Error`s
 * with messages like "Missing lock" or "Lock mismatch"; giving them the code the queue contract
 * raises keeps the adapter polymorphic with the in-memory provider and the shared contract suite,
 * while preserving the original via `cause` for debugging.
 */
export function wrapLeaseError(error: unknown, jobId: string): SixbError {
  // Identity, not meaning: skip re-wrapping what this adapter already raised. The result is thrown,
  // so it has to be a live error and not merely something code-shaped.
  if (error instanceof SixbError && error.code === "runtime.invalid_input") return error
  const message = error instanceof Error ? error.message : String(error)
  return new SixbError(
    "runtime.invalid_input",
    `[Sixb] Lease mismatch or expired for queue job '${jobId}': ${message}`,
    { cause: error instanceof Error ? error : undefined }
  )
}
