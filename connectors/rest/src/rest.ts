import type { ConnectorContext } from "@sixb/core"
import type {
  RestClient,
  RestConnector,
  RestConnectorOptions,
  RestHeadersResolver,
  RestRequestContext,
  RestRequestInit,
  RestRetryContext,
  RestRetryPolicy,
} from "./types"

const defaultRetryPolicy: Required<Pick<RestRetryPolicy, "maxRetries">> &
  Pick<RestRetryPolicy, "shouldRetry" | "delayMs"> = {
  maxRetries: 0,
  shouldRetry(context) {
    if (context.error) {
      return true
    }

    if (!context.response) {
      return false
    }

    return context.response.status === 429 || context.response.status >= 500
  },
  delayMs(context) {
    const retryAfter = context.response?.headers.get("Retry-After")
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10)
      if (Number.isFinite(seconds)) {
        return Math.max(seconds, 0) * 1000
      }
    }

    return Math.min(1000 * 2 ** context.attempt, 30_000)
  },
}

/**
 * Create a REST connector backed by the platform `fetch` implementation.
 *
 * The connected client stays close to native fetch while handling a few runtime
 * concerns centrally: base URL resolution, async headers, optional throttling,
 * timeout, retry, and one-time 401 refresh.
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
  const retryPolicy = {
    ...defaultRetryPolicy,
    ...options.retry,
  }
  let lastRequestAt = 0

  const request = async (path: string, init: RestRequestInit = {}): Promise<Response> => {
    const { retry = true, ...fetchInit } = init
    const baseRequestContext: RestRequestContext = {
      projectId: context.projectId,
      connectorId: context.connectorId,
      path,
      init: fetchInit,
    }

    let unauthorizedRetried = false
    // A stream body is consumed by the first attempt and can never be replayed,
    // so neither the 401 refresh nor the retry policy may re-send this request —
    // retrying would only mask the real failure behind a "stream already used" error.
    const replayable = !(fetchInit.body instanceof ReadableStream)

    for (let attempt = 0; ; attempt++) {
      // Apply the same pacing to retries as the initial request.
      await applyMinDelay(
        options.minDelayMs,
        () => lastRequestAt,
        (value) => {
          lastRequestAt = value
        }
      )

      const resolvedInit = await resolveRequestInit(
        fetchInit,
        options.headers,
        options.timeoutMs,
        baseRequestContext
      )

      let response: Response | null = null
      let error: unknown = null

      try {
        response = await fetch(new URL(path, options.baseUrl), resolvedInit)
      } catch (caughtError) {
        error = caughtError
      }

      // Refresh auth at most once per request to avoid retry loops on bad credentials.
      if (
        response?.status === 401 &&
        !unauthorizedRetried &&
        options.onUnauthorized &&
        replayable
      ) {
        unauthorizedRetried = true
        await options.onUnauthorized(baseRequestContext)
        continue
      }

      const retryContext: RestRetryContext = { attempt, response, error }
      const canRetry =
        retry &&
        replayable &&
        attempt < retryPolicy.maxRetries &&
        retryPolicy.shouldRetry?.(retryContext) === true

      if (canRetry) {
        await sleep(retryPolicy.delayMs?.(retryContext) ?? 0)
        continue
      }

      if (error) {
        throw error
      }

      return response as Response
    }
  }

  return {
    request,
    get(path, init) {
      return request(path, {
        ...init,
        method: init?.method ?? "GET",
      })
    },
    post(path, body, init) {
      const headers = new Headers(init?.headers)
      const requestBody = serializeBody(body, headers)

      return request(path, {
        ...init,
        method: init?.method ?? "POST",
        headers,
        body: requestBody,
      })
    },
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
  if (!headersResolver) {
    return undefined
  }

  return typeof headersResolver === "function" ? headersResolver(context) : headersResolver
}

async function applyMinDelay(
  minDelayMs: number | undefined,
  getLastRequestAt: () => number,
  setLastRequestAt: (value: number) => void
): Promise<void> {
  if (!minDelayMs || minDelayMs <= 0) {
    setLastRequestAt(Date.now())
    return
  }

  const now = Date.now()
  const elapsed = now - getLastRequestAt()
  if (elapsed < minDelayMs) {
    await sleep(minDelayMs - elapsed)
  }

  setLastRequestAt(Date.now())
}

function serializeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) {
    return undefined
  }

  if (body === null) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json")
    }
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

  // Default plain values to JSON while leaving native fetch body types alone.
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }

  return JSON.stringify(body)
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`[SixbRest] ${field} must not be empty.`)
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve) => setTimeout(resolve, ms))
}
