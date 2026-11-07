/** The two numbers that tell one retry policy from another. */
export interface BackoffPolicy {
  readonly initialMs: number
  readonly maxMs: number
}

/** How long attempt `attempt`, counted from 0, waits: the first delay doubling up to the maximum. */
export function backoffDelay(attempt: number, policy: BackoffPolicy): number {
  return Math.min(policy.initialMs * 2 ** attempt, policy.maxMs)
}

/** Waits, or stops waiting as soon as the signal aborts. Either way it resolves. */
export function waitUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }

    const timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", finish, { once: true })
  })
}

/** Rejects with the signal's reason when it aborts, and otherwise never settles. */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}
