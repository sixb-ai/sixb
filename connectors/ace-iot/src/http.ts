import type { RestClient } from "@sixb/connector-rest"
import { AceIotApiError, AceIotConfigurationError } from "./errors"
import type {
  AceIotRequestMethod,
  AceIotRetryContext,
  AceIotRetryPolicy,
  QueryParams,
  QueryValue,
} from "./types"

export interface AceIotRequestOptions {
  /**
   * Mark a write that cannot change server state, so the default policy may replay it.
   * `POST /points/get_timeseries` is the one such route: it is a read that takes a body.
   */
  readonly idempotent?: boolean
}

export interface AceIotHttp {
  get<T>(path: string, query?: QueryParams): Promise<T>
  post<T>(
    path: string,
    body?: unknown,
    query?: QueryParams,
    options?: AceIotRequestOptions
  ): Promise<T>
  put<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  patch<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  /** A GET whose body is a file. Returns the checked `Response` with its body unread. */
  download(path: string, query?: QueryParams): Promise<Response>
}

export interface AceIotHttpOptions {
  readonly minDelayMs?: number
  readonly retry?: AceIotRetryPolicy
  readonly signal?: AbortSignal
}

const DEFAULT_MAX_RETRIES = 2

export function createAceIotHttp(rest: RestClient, options: AceIotHttpOptions = {}): AceIotHttp {
  const retryPolicy = options.retry ?? {}
  const maxRetries = retryPolicy.maxRetries ?? DEFAULT_MAX_RETRIES
  assertMaxRetries(maxRetries)
  const schedule = createRequestScheduler(options.minDelayMs ?? 0)

  async function send(
    method: AceIotRequestMethod,
    path: string,
    body: unknown,
    query: QueryParams | undefined,
    idempotent: boolean
  ): Promise<Response> {
    const requestPath = withQuery(path, query)

    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null
      let error: unknown = null

      try {
        await schedule()
        response = await rest.request(requestPath, createRequestInit(method, body, options.signal))
      } catch (caughtError) {
        error = caughtError
      }

      const context: AceIotRetryContext = { attempt, method, idempotent, response, error }
      const shouldRetry =
        attempt < maxRetries &&
        (retryPolicy.shouldRetry?.(context) ?? shouldRetryByDefault(context))

      if (shouldRetry) {
        if (response?.body) {
          await response.body.cancel().catch(() => undefined)
        }
        await sleep(retryPolicy.delayMs?.(context) ?? defaultRetryDelayMs(context))
        continue
      }

      if (error) {
        throw error
      }

      return response as Response
    }
  }

  async function request<T>(
    method: AceIotRequestMethod,
    path: string,
    body?: unknown,
    query?: QueryParams,
    idempotent = method === "GET"
  ): Promise<T> {
    return readJson<T>(await send(method, path, body, query, idempotent))
  }

  return {
    get<T>(path: string, query?: QueryParams) {
      return request<T>("GET", path, undefined, query)
    },
    post<T>(
      path: string,
      body?: unknown,
      query?: QueryParams,
      requestOptions?: AceIotRequestOptions
    ) {
      return request<T>("POST", path, body, query, requestOptions?.idempotent ?? false)
    },
    put<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("PUT", path, body, query, false)
    },
    patch<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("PATCH", path, body, query, false)
    },
    async download(path: string, query?: QueryParams) {
      const response = await send("GET", path, undefined, query, true)
      if (!response.ok) {
        throw new AceIotApiError(
          response.status,
          await readResponseBody(response),
          response.headers
        )
      }

      return response
    },
  }
}

export function withQuery(path: string, query?: QueryParams): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path
  if (!query) {
    return normalizedPath
  }

  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    appendQueryParam(params, key, value)
  }

  const queryString = params.toString()
  return queryString ? `${normalizedPath}?${queryString}` : normalizedPath
}

function createRequestInit(
  method: AceIotRequestMethod,
  body: unknown,
  signal: AbortSignal | undefined
): RequestInit {
  const headers = new Headers()
  const init: RequestInit = { method, headers, signal }
  const serializedBody = serializeBody(body, headers)

  if (serializedBody !== undefined) {
    init.body = serializedBody
  }

  return init
}

function serializeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) {
    return undefined
  }

  // FormData must keep the boundary fetch generates, so no content-type is set for it here.
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

  headers.set("content-type", "application/json")
  return JSON.stringify(body)
}

async function readJson<T>(response: Response): Promise<T> {
  const responseBody = await readResponseBody(response)
  if (!response.ok) {
    throw new AceIotApiError(response.status, responseBody, response.headers)
  }

  return responseBody as T
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined
  }

  const text = await response.text()
  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Replay reads only. Every ACE write changes state — `POST /points/` and `PUT /points/{name}` merge
 * tags, and `POST /gateways/{name}/token` mints a credential — so a write is retried only when the
 * caller marks it idempotent or supplies its own policy.
 */
function shouldRetryByDefault(context: AceIotRetryContext): boolean {
  if (!(context.method === "GET" || context.idempotent) || isAbortError(context.error)) {
    return false
  }

  // A misconfigured connector fails the same way on every attempt.
  if (context.error instanceof AceIotConfigurationError) {
    return false
  }

  if (context.error) {
    return true
  }

  const status = context.response?.status
  return status === 429 || (status !== undefined && status >= 500)
}

function defaultRetryDelayMs(context: AceIotRetryContext): number {
  const retryAfter = parseRetryAfter(context.response?.headers.get("retry-after") ?? null)
  return retryAfter ?? Math.min(1000 * 2 ** context.attempt, 30_000)
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null
  }

  const seconds = Number(value)
  if (Number.isFinite(seconds)) {
    return Math.max(seconds, 0) * 1000
  }

  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : Math.max(timestamp - Date.now(), 0)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function appendQueryParam(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined || value === "") {
    return
  }

  params.set(key, String(value))
}

function assertMaxRetries(maxRetries: number): void {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbAceIot] retry.maxRetries must be a non-negative integer.")
  }
}

function createRequestScheduler(minDelayMs: number): () => Promise<void> {
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0) {
    throw new Error("[SixbAceIot] minDelayMs must be a non-negative finite number.")
  }

  if (minDelayMs === 0) {
    return () => Promise.resolve()
  }

  let nextAvailableAt = 0
  let queue = Promise.resolve()

  return () => {
    const scheduled = queue.then(async () => {
      await sleep(Math.max(nextAvailableAt - Date.now(), 0))
      nextAvailableAt = Date.now() + minDelayMs
    })
    queue = scheduled.catch(() => undefined)
    return scheduled
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
