import type { RestClient } from "@sixb/connector-rest"
import { PennylaneApiError } from "./errors"
import type {
  PennylaneRequestMethod,
  PennylaneRetryContext,
  PennylaneRetryPolicy,
  QueryParams,
  QueryValue,
} from "./types"

export interface PennylaneHttp {
  get<T>(path: string, query?: QueryParams): Promise<T>
  post<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
  put<T>(path: string, body?: unknown, query?: QueryParams): Promise<T>
}

export interface PennylaneHttpOptions {
  readonly minDelayMs?: number
  readonly retry?: PennylaneRetryPolicy
  readonly signal?: AbortSignal
}

const DEFAULT_MAX_RETRIES = 2

export function createPennylaneHttp(
  rest: RestClient,
  options: PennylaneHttpOptions = {}
): PennylaneHttp {
  const retryPolicy = options.retry ?? {}
  const maxRetries = retryPolicy.maxRetries ?? DEFAULT_MAX_RETRIES
  assertMaxRetries(maxRetries)
  const schedule = createRequestScheduler(options.minDelayMs ?? 0)

  async function request<T>(
    method: PennylaneRequestMethod,
    path: string,
    body?: unknown,
    query?: QueryParams
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

      const context: PennylaneRetryContext = { attempt, method, response, error }
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

      return readJson<T>(response as Response)
    }
  }

  return {
    get<T>(path: string, query?: QueryParams) {
      return request<T>("GET", path, undefined, query)
    },
    post<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("POST", path, body, query)
    },
    put<T>(path: string, body?: unknown, query?: QueryParams) {
      return request<T>("PUT", path, body, query)
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
  method: PennylaneRequestMethod,
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

async function readJson<T>(response: Response): Promise<T> {
  const responseBody = await readResponseBody(response)
  if (!response.ok) {
    throw new PennylaneApiError(response.status, responseBody, response.headers)
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

function shouldRetryByDefault(context: PennylaneRetryContext): boolean {
  // Quote updates can contain invoice_lines.create operations, so even PUT is not always safe.
  if (context.method !== "GET" || isAbortError(context.error)) {
    return false
  }

  if (context.error) {
    return true
  }

  const status = context.response?.status
  return status === 429 || (status !== undefined && status >= 500)
}

function defaultRetryDelayMs(context: PennylaneRetryContext): number {
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
    throw new Error("[SixbPennylane] retry.maxRetries must be a non-negative integer.")
  }
}

function createRequestScheduler(minDelayMs: number): () => Promise<void> {
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0) {
    throw new Error("[SixbPennylane] minDelayMs must be a non-negative finite number.")
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
