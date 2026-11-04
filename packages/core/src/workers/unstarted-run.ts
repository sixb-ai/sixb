import type { QueueWorkerFailureDecision } from "./queue-worker"

const UNSTARTED_RUN_ATTEMPTS = 3
const UNSTARTED_RUN_RETRY_INITIAL_DELAY_MS = 250

/**
 * A run that has not started has committed nothing, so a job that fails before starting it is
 * retried with a short doubling backoff. Returns `undefined` once its attempts are spent: the
 * worker then fails the run, so that later triggers stop joining it.
 */
export function retryUnstartedRun(
  attempt: number
): Extract<QueueWorkerFailureDecision, { readonly kind: "retry" }> | undefined {
  if (attempt >= UNSTARTED_RUN_ATTEMPTS) return undefined

  const delayMs = UNSTARTED_RUN_RETRY_INITIAL_DELAY_MS * 2 ** (Math.max(attempt, 1) - 1)
  return { kind: "retry", availableAt: new Date(Date.now() + delayMs).toISOString() }
}
