/**
 * Await one observer delivery, or detach it on unsubscribe. The observer's owner
 * remains responsible for cancellation/draining. Rejections are observed even
 * after detaching; each completed delivery removes its abort listener.
 *
 * Do not race every batch against one permanent stop promise: that retains a
 * promise reaction per batch for the subscription's entire lifetime.
 */
export async function waitForSubscriber(result: unknown, signal: AbortSignal): Promise<void> {
  let onAbort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = resolve
      signal.addEventListener("abort", onAbort, { once: true })
      Promise.resolve(result).then(() => resolve(), reject)
      if (signal.aborted) resolve()
    })
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}
