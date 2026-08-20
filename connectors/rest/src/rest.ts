import type { ConnectorContext } from "@sixb/core"
import { isAbortError, restRetryDelayMs, shouldRetryRestRequest } from "./helpers"
import type {
  RestClient,
  RestConnector,
  RestConnectorOptions,
  RestHeadersResolver,
  RestRequestContext,
  RestRequestInit,
  RestRequestOptions,
  RestRetryContext,
} from "./types"

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Create a REST connector backed by the platform `fetch` implementation.
 *
 * The connected client stays close to native fetch while handling runtime concerns centrally:
 * base URL resolution, async headers, serialized pacing, timeout, method-aware retry, response
 * cleanup, body replay safety, and one-time 401 refresh.
 */
export function rest(options: RestConnectorOptions): RestConnector {
  assertNonEmpty(options.baseUrl, "baseUrl")

  return {
    type: "rest",
    webhooks: options.webhooks,
    connect(context: ConnectorContext) {
      return createRestClient(options, context)
    },
  }
}

function createRestClient(options: RestConnectorOptions, context: ConnectorContext): RestClient {
  const maxRetries = options.retry?.maxRetries ?? 0
  assertMaxRetries(maxRetries)
  const shouldRetry = options.retry?.shouldRetry ?? shouldRetryRestRequest
  const delayMs = options.retry?.delayMs ?? restRetryDelayMs
  const schedule = createRequestScheduler(options.minDelayMs ?? 0)

  const request = async (
    path: string,
    init: RestRequestInit = {},
    requestOptions: RestRequestOptions = {}
  ): Promise<Response> => {
    const { retry, ...requestInit } = init
    const preparedInit = prepareRequestInit(requestInit)
    const method = (preparedInit.method ?? "GET").toUpperCase()
    const idempotent = requestOptions.idempotent ?? safeMethods.has(method)
    const retryable = requestOptions.retryable ?? retry ?? true
    const bodyReplayable = !(preparedInit.body instanceof ReadableStream)
    const requestSignal = combineSignals(context.signal, preparedInit.signal)
    const baseRequestContext: RestRequestContext = {
      projectId: context.projectId,
      connectorId: context.connectorId,
      path,
      init: { ...preparedInit, signal: requestSignal },
      method,
      idempotent,
      bodyReplayable,
    }

    let unauthorizedRetried = false
    let retryAttempt = 0

    for (;;) {
      let response: Response | null = null
      let error: unknown = null

      try {
        // The queue reserves a distinct start slot for every initial request and retry.
        await schedule(requestSignal)
        const resolvedInit = await resolveRequestInit(
          baseRequestContext.init,
          options.headers,
          options.timeoutMs,
          baseRequestContext
        )
        response = await fetch(new URL(path, options.baseUrl), resolvedInit)
      } catch (caughtError) {
        error = caughtError
      }

      const retryContext: RestRetryContext = {
        ...baseRequestContext,
        attempt: retryAttempt,
        response,
        error,
      }

      // Authentication refresh is also a replay, so it follows the same semantic and mechanical
      // safety gates as an ordinary retry. Refresh at most once to avoid bad-credential loops.
      if (
        response?.status === 401 &&
        !unauthorizedRetried &&
        options.onUnauthorized &&
        retryable &&
        idempotent &&
        bodyReplayable
      ) {
        unauthorizedRetried = true
        await cancelResponseBody(response)
        await options.onUnauthorized(baseRequestContext)
        continue
      }

      const canRetry =
        retryable &&
        bodyReplayable &&
        !isAbortError(error) &&
        retryAttempt < maxRetries &&
        shouldRetry(retryContext)

      if (canRetry) {
        retryAttempt += 1
        await cancelResponseBody(response)
        await sleep(delayMs(retryContext), requestSignal)
        continue
      }

      if (error) throw error
      return response as Response
    }
  }

  return {
    request,
    get(path, init, requestOptions) {
      return request(
        path,
        {
          ...init,
          method: init?.method ?? "GET",
        },
        requestOptions
      )
    },
    post(path, body, init, requestOptions) {
      return request(
        path,
        {
          ...init,
          method: init?.method ?? "POST",
          body,
        },
        requestOptions
      )
    },
  }
}

function prepareRequestInit(init: RestRequestInit): RequestInit {
  const headers = new Headers(init.headers)
  const body = serializeBody(init.body, headers)
  return {
    ...init,
    headers,
    body,
  }
}

async function resolveRequestInit(
  init: RequestInit,
  headersResolver: RestHeadersResolver | undefined,
  timeoutMs: number | undefined,
  context: RestRequestContext
): Promise<RequestInit> {
  const headers = new Headers(await resolveHeaders(headersResolver, context))

  for (const [key, value] of new Headers(init.headers)) {
    headers.set(key, value)
  }

  const signal =
    timeoutMs === undefined
      ? init.signal
      : init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs)

  return {
    ...init,
    headers,
    signal,
  }
}

async function resolveHeaders(
  headersResolver: RestHeadersResolver | undefined,
  context: RestRequestContext
): Promise<HeadersInit | undefined> {
  if (!headersResolver) return undefined
  return typeof headersResolver === "function" ? headersResolver(context) : headersResolver
}

function serializeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined

  if (body === null) {
    setJsonContentType(headers)
    return JSON.stringify(body)
  }

  if (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ReadableStream
  ) {
    return body as BodyInit
  }

  setJsonContentType(headers)
  return JSON.stringify(body)
}

function setJsonContentType(headers: Headers): void {
  if (!headers.has("content-type")) headers.set("content-type", "application/json")
}

function combineSignals(
  contextSignal: AbortSignal,
  requestSignal: AbortSignal | null | undefined
): AbortSignal {
  if (!requestSignal || requestSignal === contextSignal) return contextSignal
  return AbortSignal.any([contextSignal, requestSignal])
}

function createRequestScheduler(minDelayMs: number): (signal: AbortSignal) => Promise<void> {
  assertMinDelay(minDelayMs)
  if (minDelayMs === 0) {
    return (signal) => (signal.aborted ? Promise.reject(abortReason(signal)) : Promise.resolve())
  }

  let nextAvailableAt = 0
  let queue = Promise.resolve()

  return (signal) => {
    const scheduled = queue.then(async () => {
      await sleep(Math.max(nextAvailableAt - Date.now(), 0), signal)
      nextAvailableAt = Date.now() + minDelayMs
    })
    queue = scheduled.catch(() => undefined)
    // A request can sit behind another request's pacing slot. Reject its caller immediately when
    // aborted; the queued task will later observe the same signal and release the queue cleanly.
    return abortable(scheduled, signal)
  }
}

async function cancelResponseBody(response: Response | null): Promise<void> {
  if (response?.body) await response.body.cancel().catch(() => undefined)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))
  if (ms <= 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(abortReason(signal as AbortSignal))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

function assertMaxRetries(maxRetries: number): void {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbRest] retry.maxRetries must be a non-negative integer.")
  }
}

function assertMinDelay(minDelayMs: number): void {
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0) {
    throw new Error("[SixbRest] minDelayMs must be a non-negative finite number.")
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`[SixbRest] ${field} must not be empty.`)
  }
}
