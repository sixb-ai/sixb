import { isSixbError, SixbError } from "@sixb/core/errors"

/**
 * Wraps a BullMQ lock/token rejection as `runtime.invalid_input`. BullMQ throws generic `Error`s
 * with messages like "Missing lock" or "Lock mismatch"; giving them the code the queue contract
 * raises keeps the adapter polymorphic with the in-memory provider and the shared contract suite,
 * while preserving the original via `cause` for debugging.
 */
export function wrapLeaseError(error: unknown, jobId: string): SixbError {
  if (isSixbError(error, "runtime.invalid_input")) return error
  const message = error instanceof Error ? error.message : String(error)
  return new SixbError(
    "runtime.invalid_input",
    `[Sixb] Lease mismatch or expired for queue job '${jobId}': ${message}`,
    { cause: error instanceof Error ? error : undefined }
  )
}
