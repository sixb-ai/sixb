import { ModelProviderError } from "@sixb/core/models"
import { RequestDiagnostics } from "./diagnostics"
import { object, PREFIX, positiveInteger } from "./util"

export type ValueSource<T> = T | ((signal: AbortSignal) => T | Promise<T>)
export type FoundryProtocol = "responses" | "messages" | "chat"

export interface TransportOptions {
  readonly endpoint: string
  readonly apiKey: ValueSource<string | undefined>
  readonly headers?: ValueSource<Readonly<Record<string, string>>>
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly maxRetries?: number
  readonly maxRetryDelayMs?: number
}

export class FoundryTransport {
  private readonly diagnostics = new WeakMap<Response, RequestDiagnostics>()
  readonly baseUrl: string
  readonly projectUrl: string
  private readonly options: TransportOptions

  constructor(options: TransportOptions, target: "project" | "resource" = "project") {
    if (!URL.canParse(options.endpoint))
      throw new TypeError(`${PREFIX} endpoint must be a valid ${target} URL.`)
    const url = new URL(options.endpoint)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(
        `${PREFIX} endpoint must be an HTTP(S) ${target} URL without credentials, query, or fragment.`
      )
    }
    const path = url.pathname.replace(/\/+$/, "")
    if (target === "project" && !/^\/api\/projects\/[^/]+$/.test(path))
      throw new TypeError(
        `${PREFIX} endpoint must be a Foundry project URL: https://<resource>.services.ai.azure.com/api/projects/<project>.`
      )
    if (target === "resource" && path !== "" && path !== "/openai/v1")
      throw new TypeError(
        `${PREFIX} embeddings.endpoint must be a resource origin or /openai/v1 URL.`
      )
    this.projectUrl = `${url.origin}${path}`
    this.baseUrl = target === "project" ? `${this.projectUrl}/openai/v1` : `${url.origin}/openai/v1`
    if (
      typeof options.apiKey !== "function" &&
      (typeof options.apiKey !== "string" || !options.apiKey.trim())
    )
      throw new TypeError(`${PREFIX} apiKey is required.`)
    if (
      options.maxRetries !== undefined &&
      (!Number.isSafeInteger(options.maxRetries) || options.maxRetries < 0)
    ) {
      throw new TypeError(`${PREFIX} maxRetries must be a nonnegative safe integer.`)
    }
    positiveInteger(options.maxRetryDelayMs, "maxRetryDelayMs")
    this.options = {
      ...options,
      headers: typeof options.headers === "function" ? options.headers : { ...options.headers },
    }
  }

  async post(
    body: string,
    signal: AbortSignal,
    providerId: string,
    modelId: string,
    protocol: FoundryProtocol | "embeddings" = "responses"
  ): Promise<Response> {
    const url = this.url(protocol)
    const diagnostics = new RequestDiagnostics()
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const headers = await this.headers(
        signal,
        diagnostics,
        protocol === "messages" ? "x-api-key" : "api-key"
      )
      headers.set("content-type", "application/json")
      headers.set("accept", protocol === "embeddings" ? "application/json" : "text/event-stream")
      if (protocol === "messages") headers.set("anthropic-version", "2023-06-01")
      signal.throwIfAborted()
      // Ambiguous network failures and accepted streams are never automatically replayed.
      const response = await abortable(async () => {
        const result = await this.fetch(url, {
          method: "POST",
          // Redirects can forward API keys and prompt bodies to another origin.
          redirect: "error",
          headers,
          body,
          signal,
        })
        // An injected fetch can finish after the caller has already cancelled.
        if (signal.aborted) void result.body?.cancel(signal.reason).catch(() => {})
        return result
      }, signal).catch((error: unknown) => {
        if (signal.aborted) throw signal.reason
        throw diagnostics.failure(error)
      })
      this.diagnostics.set(response, diagnostics)
      if (signal.aborted) {
        void response.body?.cancel(signal.reason).catch(() => {})
        signal.throwIfAborted()
      }
      if (response.ok) return response
      const error = this.redactError(
        response,
        await httpError(response, providerId, modelId, signal)
      )
      if (
        protocol === "embeddings" ||
        !error.retryable ||
        attempt >= (this.options.maxRetries ?? 2)
      )
        throw error
      await wait(
        Math.min(error.retryAfterMs ?? 250 * 2 ** attempt, this.options.maxRetryDelayMs ?? 60_000),
        signal
      )
    }
  }

  redactText(response: Response, value: string | undefined): string | undefined {
    return value === undefined ? undefined : (this.diagnostics.get(response)?.text(value) ?? value)
  }

  redactError(response: Response, error: ModelProviderError): ModelProviderError {
    return this.diagnostics.get(response)!.providerError(error)
  }

  redactFailure(response: Response, error: unknown): unknown {
    return this.diagnostics.get(response)!.failure(error)
  }

  async headers(
    signal: AbortSignal,
    diagnostics: RequestDiagnostics,
    keyHeader: "api-key" | "x-api-key" = "api-key"
  ): Promise<Headers> {
    const headers = new Headers(await resolve(this.options.headers, signal))
    for (const value of headers.values()) diagnostics.add(value)
    for (const reserved of ["authorization", "api-key", "x-api-key"])
      if (headers.has(reserved))
        throw new TypeError(`${PREFIX} Use apiKey instead of '${reserved}' headers.`)
    const key = await resolve(this.options.apiKey, signal)
    if (typeof key !== "string" || !key.trim())
      throw new TypeError(`${PREFIX} apiKey must resolve to a nonempty string.`)
    diagnostics.add(key)
    headers.set(keyHeader, key)
    return headers
  }

  fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(url, init)
  }

  url(protocol: FoundryProtocol | "embeddings"): string {
    if (protocol === "embeddings") return `${this.baseUrl}/embeddings`
    if (protocol === "responses") return `${this.baseUrl}/responses`
    if (protocol === "chat") return `${this.baseUrl}/chat/completions`
    return `${new URL(this.baseUrl).origin}/anthropic/v1/messages`
  }
}

export function requestId(response: Response): string | undefined {
  return (
    response.headers.get("apim-request-id") ??
    response.headers.get("x-request-id") ??
    response.headers.get("request-id") ??
    undefined
  )
}

async function resolve<T>(
  source: ValueSource<T> | undefined,
  signal: AbortSignal
): Promise<T | undefined> {
  signal.throwIfAborted()
  if (typeof source !== "function") return source
  return abortable(() => (source as (signal: AbortSignal) => T | Promise<T>)(signal), signal)
}

/** Bound credential/transport work even when an injected implementation ignores the signal. */
export function abortable<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return operation()
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

async function httpError(
  response: Response,
  providerId: string,
  modelId: string,
  signal: AbortSignal
): Promise<ModelProviderError> {
  let message = `Provider request failed with HTTP ${response.status}.`
  let code: string | undefined
  const reader = response.body?.getReader()
  if (reader) {
    const cancel = () => {
      void reader.cancel(signal.reason).catch(() => {})
    }
    signal.addEventListener("abort", cancel, { once: true })
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (length < 8_192) {
        signal.throwIfAborted()
        const { value, done } = await abortable(() => reader.read(), signal)
        if (done) break
        const part = value.subarray(0, 8_192 - length)
        chunks.push(part)
        length += part.length
      }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const error = object(object(parsed)?.error)
      if (typeof error?.message === "string") message = error.message
      if (typeof error?.code === "string") code = error.code
      else if (typeof error?.type === "string") code = error.type
    } catch {
      // Arbitrary/partial error bodies stay private; the HTTP status remains actionable.
    } finally {
      signal.removeEventListener("abort", cancel)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  signal.throwIfAborted()
  const delay =
    response.headers.get("retry-after-ms") ?? response.headers.get("x-ms-retry-after-ms")
  const retry = response.headers.get("retry-after")
  const ms =
    delay !== null
      ? Number(delay)
      : retry !== null
        ? Number.isFinite(Number(retry))
          ? Number(retry) * 1_000
          : Date.parse(retry) - Date.now()
        : undefined
  return new ModelProviderError(`${PREFIX} ${message}`, providerId, modelId, {
    status: response.status,
    requestId: requestId(response),
    code,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    ...(ms !== undefined && Number.isFinite(ms) && ms >= 0 ? { retryAfterMs: Math.ceil(ms) } : {}),
  })
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}
