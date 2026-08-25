import type { RestClient } from "@sixb/connector-rest"
import { LinkedinApiError, LinkedinConfigurationError } from "./errors"
import type { LinkedinCreatedEntity, LinkedinCreatedResource } from "./types/common"
import type {
  LinkedinRequestMethod,
  LinkedinRetryContext,
  LinkedinRetryPolicy,
} from "./types/options"

export interface LinkedinHttp {
  get<T>(path: string, init?: RequestInit): Promise<T>
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>
  put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>
  delete<T>(path: string, init?: RequestInit): Promise<T>
  create(path: string, body: unknown, init?: RequestInit): Promise<LinkedinCreatedEntity>
  createWithResponse<T>(
    path: string,
    body: unknown,
    init?: RequestInit
  ): Promise<LinkedinCreatedResource<T>>
}

export interface LinkedinHttpOptions {
  readonly minDelayMs?: number
  readonly retry?: LinkedinRetryPolicy
  readonly signal?: AbortSignal
  readonly queryTunnelingThreshold: number
}

const DEFAULT_MAX_RETRIES = 2

export function createLinkedinHttp(rest: RestClient, options: LinkedinHttpOptions): LinkedinHttp {
  const retryPolicy = options.retry ?? {}
  const maxRetries = retryPolicy.maxRetries ?? DEFAULT_MAX_RETRIES
  assertNonNegativeInteger(maxRetries, "retry.maxRetries")
  assertNonNegativeInteger(options.queryTunnelingThreshold, "queryTunnelingThreshold")
  const schedule = createRequestScheduler(options.minDelayMs ?? 0)

  async function request<T>(
    method: LinkedinRequestMethod,
    path: string,
    body?: unknown,
    init?: RequestInit
  ): Promise<{ readonly data: T; readonly headers: Headers }> {
    const prepared = prepareRequest(method, path, body, init, options)

    for (let attempt = 0; ; attempt++) {
      let response: Response | null = null
      let error: unknown = null
      try {
        await schedule()
        response = await rest.request(prepared.path, prepared.init)
      } catch (caughtError) {
        error = caughtError
      }

      const context: LinkedinRetryContext = { attempt, method, response, error }
      const shouldRetry =
        attempt < maxRetries &&
        !(error instanceof LinkedinConfigurationError) &&
        (retryPolicy.shouldRetry?.(context) ?? shouldRetryByDefault(context))

      if (shouldRetry) {
        if (response?.body) await response.body.cancel().catch(() => undefined)
        await sleep(retryPolicy.delayMs?.(context) ?? defaultRetryDelayMs(context))
        continue
      }
      if (error) throw error

      const resolved = response as Response
      return { data: await readResponse<T>(resolved), headers: resolved.headers }
    }
  }

  return {
    get: <T>(path: string, init?: RequestInit) =>
      request<T>("GET", path, undefined, init).then((result) => result.data),
    post: <T>(path: string, body?: unknown, init?: RequestInit) =>
      request<T>("POST", path, body, init).then((result) => result.data),
    put: <T>(path: string, body?: unknown, init?: RequestInit) =>
      request<T>("PUT", path, body, init).then((result) => result.data),
    delete: <T>(path: string, init?: RequestInit) =>
      request<T>("DELETE", path, undefined, init).then((result) => result.data),
    async create(path, body, init) {
      const result = await request<unknown>("POST", path, body, init)
      return { id: createdId(result.headers) }
    },
    async createWithResponse<T>(path: string, body: unknown, init?: RequestInit) {
      const result = await request<T>("POST", path, body, init)
      return { id: createdId(result.headers), data: result.data }
    },
  }
}

function createdId(headers: Headers): string {
  const id = headers.get("x-restli-id")
  if (!id) {
    throw new Error("[SixbLinkedin] Create response is missing the x-restli-id header.")
  }
  return id
}

function prepareRequest(
  method: LinkedinRequestMethod,
  path: string,
  body: unknown,
  init: RequestInit | undefined,
  options: LinkedinHttpOptions
): { readonly path: string; readonly init: RequestInit } {
  const headers = new Headers(init?.headers)
  const signal = mergeSignals(init?.signal, options.signal)

  if (method === "GET" && shouldTunnel(path, options.queryTunnelingThreshold)) {
    const separator = path.indexOf("?")
    const query = path.slice(separator + 1)
    headers.set("content-type", "application/x-www-form-urlencoded")
    headers.set("x-http-method-override", "GET")
    return {
      path: path.slice(0, separator),
      init: { ...init, method: "POST", headers, body: query, signal },
    }
  }

  const serializedBody = serializeBody(body, headers)
  return {
    path,
    init: { ...init, method, headers, body: serializedBody, signal },
  }
}

function shouldTunnel(path: string, threshold: number): boolean {
  const separator = path.indexOf("?")
  if (separator < 0) return false
  return new TextEncoder().encode(path.slice(separator + 1)).byteLength >= threshold
}

function serializeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined
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

  if (!headers.has("content-type")) headers.set("content-type", "application/json")
  return JSON.stringify(body)
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await readBody(response)
  if (!response.ok) {
    throw new LinkedinApiError(response.status, body, response.headers)
  }
  return body as T
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function shouldRetryByDefault(context: LinkedinRetryContext): boolean {
  if (context.method !== "GET" || isAbortError(context.error)) return false
  if (context.error) return true
  const status = context.response?.status
  return status === 429 || (status !== undefined && status >= 500)
}

function defaultRetryDelayMs(context: LinkedinRetryContext): number {
  const retryAfter = parseRetryAfter(context.response?.headers.get("retry-after") ?? null)
  return retryAfter ?? Math.min(1000 * 2 ** context.attempt, 30_000)
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(seconds, 0) * 1000
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : Math.max(timestamp - Date.now(), 0)
}

function mergeSignals(
  requestSignal: AbortSignal | null | undefined,
  contextSignal: AbortSignal | undefined
): AbortSignal | undefined {
  if (requestSignal && contextSignal) return AbortSignal.any([requestSignal, contextSignal])
  return requestSignal ?? contextSignal
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

function createRequestScheduler(minDelayMs: number): () => Promise<void> {
  if (!Number.isFinite(minDelayMs) || minDelayMs < 0) {
    throw new Error("[SixbLinkedin] minDelayMs must be a non-negative finite number.")
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

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`[SixbLinkedin] ${field} must be a non-negative integer.`)
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
