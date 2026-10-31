export const NEVER_ABORTED_SIGNAL = new AbortController().signal

/** Await a promise while allowing a signal to stop waiting for providers without cancellation. */
export function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

/** Wait `ms`, or until `wake` settles, or until the signal aborts, rejecting with its reason. */
export function delay(ms: number, signal: AbortSignal, wake?: Promise<void>): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    void wake?.then(finish)
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}
