import { createAmbiguousProviderOperationError } from "../errors"

export interface BoundedConnectorProviderOperationOptions {
  readonly hostSignal: AbortSignal
  readonly timeoutMs: number
}

/** Bound one provider call to both the current host lifetime and an explicit deadline. */
export async function runBoundedConnectorProviderOperation<T>(
  options: BoundedConnectorProviderOperationOptions,
  run: (signal: AbortSignal) => Promise<T> | T,
  interruptionError: () => Error = createAmbiguousProviderOperationError
): Promise<T> {
  const controller = new AbortController()
  const abortFromHost = () => controller.abort(interruptionError())
  if (options.hostSignal.aborted) abortFromHost()
  else options.hostSignal.addEventListener("abort", abortFromHost, { once: true })

  const timeout = setTimeout(() => controller.abort(interruptionError()), options.timeoutMs)
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAborted = () => reject(abortReason(controller.signal))
    if (controller.signal.aborted) rejectAborted()
    else controller.signal.addEventListener("abort", rejectAborted, { once: true })
  })
  const operation = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw abortReason(controller.signal)
    return run(controller.signal)
  })
  operation.catch(() => {})

  try {
    return await Promise.race([operation, aborted])
  } finally {
    clearTimeout(timeout)
    options.hostSignal.removeEventListener("abort", abortFromHost)
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : createAmbiguousProviderOperationError()
}
