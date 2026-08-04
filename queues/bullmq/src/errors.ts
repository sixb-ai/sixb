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
 * True when BullMQ's own Lua script answered, rather than the driver failing.
 *
 * `Scripts.finishedErrors()` builds a plain `Error` and then does `error.code = code`, where `code`
 * is one of BullMQ's negative `ErrorCode`s (`-2` missing lock, `-3` wrong state, `-6` lock
 * mismatch). Verified against bullmq 5.77.1, and reproduced both ways: a wrong token answers
 * `code: -6`, while the same call over a destroyed connection answers "Connection is closed." with
 * no `code` at all.
 *
 * That numeric code is the whole discriminator, and it is why this does not match on message text:
 * a script answer means the queue is reachable and the *lease* is what is wrong, and anything else
 * reaching a `catch` here means Redis is what is wrong. ioredis codes are strings (`ECONNREFUSED`),
 * so they cannot be confused with these.
 */
function isBullMqScriptError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  return typeof (error as { readonly code?: unknown }).code === "number"
}

/**
 * Wraps a BullMQ lock/token rejection as `runtime.invalid_input` — the code the queue contract
 * raises for a lease that no longer holds, which keeps this adapter polymorphic with the in-memory
 * provider and the shared contract suite. The original is preserved via `cause`.
 *
 * A rejection that is *not* a script answer never gets that code: a Redis outage during settlement
 * would otherwise be reported as the caller's bad input and answered `400`, which is the same defect
 * {@link wrapDriverError} exists to prevent one call earlier. Note that `queue.lease_lost` is
 * deliberately not used here — core raises it a layer up, when it observes the lease expire.
 */
export function wrapLeaseError(error: unknown, jobId: string, operation: string): SixbError {
  // Identity, not meaning: skip re-wrapping what this adapter already raised. The result is thrown,
  // so it has to be a live error and not merely something code-shaped.
  if (error instanceof SixbError && error.code === "runtime.invalid_input") return error
  if (!isBullMqScriptError(error)) return wrapDriverError(error, operation)
  const message = error instanceof Error ? error.message : String(error)
  return new SixbError(
    "runtime.invalid_input",
    `[Sixb] Lease mismatch or expired for queue job '${jobId}': ${message}`,
    { cause: error instanceof Error ? error : undefined }
  )
}

/**
 * Extends a job's lock, distinguishing "the lease is gone" from "Redis is gone".
 *
 * `extendLock` reports a token mismatch by *returning* `0` — it does not throw — so a rejection here
 * is never a lease answer. Folding both into one boolean, as this did, turned a transient outage
 * into a lease loss: the job was abandoned and redelivered while nothing anywhere said
 * `queue.unavailable`. Returning `false` now means the lock is genuinely not ours; a driver failure
 * is raised, which is what the renewal loop already reports through `onRenewalError`.
 */
export async function extendLockOrThrow(
  extend: () => Promise<number | string>,
  operation: string
): Promise<boolean> {
  try {
    return Number(await extend()) > 0
  } catch (error) {
    // A negative script code here means the lock itself is gone (`-2` missing, `-6` mismatch),
    // which is the same answer as a returned `0`.
    if (isBullMqScriptError(error)) return false
    throw wrapDriverError(error, operation)
  }
}
