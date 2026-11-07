const INITIAL_DELAY_MS = 250
const MAX_DELAY_MS = 10_000

/** 250 ms doubling to 10 s. */
export function retryDelay(attempt: number): number {
  return Math.min(INITIAL_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
}

/** Waits, or stops waiting as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }

    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}
