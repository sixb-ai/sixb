import { ModelProviderError } from "@sixb/core/models"
import { object, PREFIX, positiveInteger } from "./util"

export type ValueSource<T> = T | ((signal: AbortSignal) => T | Promise<T>)
export type FoundryProtocol = "responses" | "messages" | "chat"

export interface TransportOptions {
  readonly endpoint: string
  readonly apiKey?: ValueSource<string | undefined>
  /** Supply an Entra access token (without 'Bearer '); called on every HTTP attempt. */
  readonly tokenProvider?: (signal: AbortSignal) => string | Promise<string>
  readonly headers?: ValueSource<Readonly<Record<string, string>>>
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly maxRetries?: number
  readonly maxRetryDelayMs?: number
}

export class FoundryTransport {
  readonly baseUrl: string
  readonly project: boolean
  private readonly options: TransportOptions

  constructor(options: TransportOptions) {
    if (!URL.canParse(options.endpoint))
      throw new TypeError(`${PREFIX} endpoint must be a valid resource/project URL.`)
    const url = new URL(options.endpoint)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(
        `${PREFIX} endpoint must be an HTTP(S) resource/project URL without credentials, query, or fragment.`
      )
    }
    let path = url.pathname.replace(/\/+$/, "")
    if (path === "/anthropic" || path === "/anthropic/v1") path = ""
    if (path.endsWith("/openai/v1")) path = path.slice(0, -10)
    this.project = /^\/api\/projects\/[^/]+$/.test(path)
    if (path !== "" && !this.project) {
      throw new TypeError(
        `${PREFIX} endpoint must be a resource root (optionally /anthropic or /anthropic/v1) or /api/projects/<project>, optionally ending in /openai/v1.`
      )
    }
    this.baseUrl = `${url.origin}${path}/openai/v1`
    if (options.apiKey !== undefined && options.tokenProvider !== undefined) {
      throw new TypeError(`${PREFIX} Configure either apiKey or tokenProvider, not both.`)
    }
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
    protocol: FoundryProtocol = "responses"
  ): Promise<Response> {
    const url = this.url(protocol)
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const headers = new Headers(await resolve(this.options.headers, signal))
      for (const reserved of ["authorization", "api-key", "x-api-key"]) {
        if (headers.has(reserved))
          throw new TypeError(
            `${PREFIX} Use apiKey/tokenProvider instead of '${reserved}' headers.`
          )
      }
      const token = this.options.tokenProvider
        ? await resolve(this.options.tokenProvider, signal)
        : await resolve(this.options.apiKey ?? (() => process.env.AZURE_AI_FOUNDRY_API_KEY), signal)
      if (typeof token !== "string" || !token.trim())
        throw new TypeError(`${PREFIX} An API key or Entra token is required.`)
      headers.set(
        this.options.tokenProvider
          ? "authorization"
          : protocol === "messages"
            ? "x-api-key"
            : "api-key",
        this.options.tokenProvider ? `Bearer ${token}` : token
      )
      headers.set("content-type", "application/json")
      headers.set("accept", "text/event-stream")
      if (protocol === "messages") headers.set("anthropic-version", "2023-06-01")
      signal.throwIfAborted()
      // Ambiguous network failures and accepted streams are never automatically replayed.
      const response = await (this.options.fetch ?? fetch)(url, {
        method: "POST",
        headers,
        body,
        signal,
      })
      if (response.ok) return response
      const error = await httpError(response, providerId, modelId, signal)
      if (!error.retryable || attempt >= (this.options.maxRetries ?? 2)) throw error
      await wait(
        Math.min(error.retryAfterMs ?? 250 * 2 ** attempt, this.options.maxRetryDelayMs ?? 60_000),
        signal
      )
    }
  }

  get entra(): boolean {
    return this.options.tokenProvider !== undefined
  }

  url(protocol: FoundryProtocol): string {
    if (protocol === "responses") return `${this.baseUrl}/responses`
    if (protocol === "chat") return `${this.baseUrl}/chat/completions`
    if (this.project)
      throw new TypeError(
        `${PREFIX} Native Messages requires a resource endpoint; a project endpoint cannot identify the connected Claude resource. Configure a separate resource provider.`
      )
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
    const abort = () => reject(signal.reason)
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
        const { value, done } = await reader.read()
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
      await reader.cancel().catch(() => {})
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
