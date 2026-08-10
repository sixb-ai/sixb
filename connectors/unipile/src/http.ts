import type { RestClient } from "@sixb/connector-rest"
import { UnipileApiError } from "./errors"
import type {
  QueryParams,
  QueryValue,
  UnipileRequestMethod,
  UnipileRetryContext,
  UnipileRetryPolicy,
} from "./types"

export interface UnipileHttp {
  get<T>(path: string, query?: QueryParams, retryable?: boolean): Promise<T>
  post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  delete<T>(path: string, query?: QueryParams): Promise<T>
}

export interface UnipileHttpOptions {
  readonly minDelayMs?: number
  readonly retry?: UnipileRetryPolicy
  readonly signal?: AbortSignal
}

const DEFAULT_MAX_RETRIES = 2

export function createUnipileHttp(rest: RestClient, options: UnipileHttpOptions = {}): UnipileHttp {
  const retryPolicy = options.retry ?? {}
  const maxRetries = retryPolicy.maxRetries ?? DEFAULT_MAX_RETRIES
  assertMaxRetries(maxRetries)
  const schedule = createRequestScheduler(options.minDelayMs ?? 0)

  async function request<T>(
    method: UnipileRequestMethod,
    path: string,
    body?: unknown,
    query?: QueryParams,
    retryable = false
  ): Promise<T> {
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

      const context: UnipileRetryContext = { attempt, method, path, response, error }
      const shouldRetry =
        retryable &&
        !isAbortError(error) &&
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

      return readResponse<T>(response as Response)
    }
  }

  return {
    get<T>(path: string, query?: QueryParams, retryable = false) {
      return request<T>("GET", path, undefined, query, retryable)
    },
    post<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("POST", path, body, query)
    },
    delete<T>(path: string, query?: QueryParams) {
      return request<T>("DELETE", path, undefined, query)
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
  method: UnipileRequestMethod,
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

async function readResponse<T>(response: Response): Promise<T> {
  const body = await readResponseBody(response)
  if (!response.ok) {
    throw new UnipileApiError(response.status, body, response.headers)
  }
  return body as T
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

function shouldRetryByDefault(context: UnipileRetryContext): boolean {
  if (context.error) {
    // Native fetch reports transport failures as TypeError. Do not replay configuration,
    // credential-resolver, or caller errors merely because they happened before a response.
    return context.error instanceof TypeError
  }
  const status = context.response?.status
  return status === 429 || (status !== undefined && status >= 500)
}

function defaultRetryDelayMs(context: UnipileRetryContext): number {
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

function appendQueryParam(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined) {
    return
  }
  if (Array.isArray(value)) {
    // Unipile models multi-value query filters as one comma-separated string, not repeated keys.
    params.set(key, value.map(String).join(","))
    return
  }
  params.set(key, String(value))
}

function assertMaxRetries(maxRetries: number): void {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("[SixbUnipile] retry.maxRetries must be a non-negative integer.")
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function createRequestScheduler(minDelayMs: number): () => Promise<void> {
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0) {
    throw new Error("[SixbUnipile] minDelayMs must be a non-negative finite number.")
  }

  let nextAvailableAt = 0
  let queue = Promise.resolve()

  return () => {
    const scheduled = queue.then(async () => {
      const waitMs = Math.max(nextAvailableAt - Date.now(), 0)
      await sleep(waitMs)
      nextAvailableAt = Date.now() + minDelayMs
    })
    queue = scheduled.catch(() => undefined)
    return scheduled
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
