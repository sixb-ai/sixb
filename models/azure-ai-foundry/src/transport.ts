import { ModelProviderError } from "@sixb/core/models"
import { contextWindowRejection } from "@sixb/model-protocols/responses"
import { RequestDiagnostics } from "./diagnostics"
import { object, PREFIX, positiveInteger } from "./util"

export type ValueSource<T> = T | ((signal: AbortSignal) => T | Promise<T>)
export type FoundryProtocol = "responses" | "messages" | "chat"
type FoundryRoute = FoundryProtocol | OneShotRoute
/** Routes that answer in one body. A failure is never replayed: the call may have been billed. */
type OneShotRoute =
  | "embeddings"
  | "decision"
  | "transcription"
  | "reranking"
  | "speech"
  | "image"
  | "image-edit"
const ONE_SHOT: ReadonlySet<FoundryRoute> = new Set<OneShotRoute>([
  "embeddings",
  "decision",
  "transcription",
  "reranking",
  "speech",
  "image",
  "image-edit",
])

/** The GA data-plane version: the v1 API does not route audio deployments. */
const AUDIO_API_VERSION = "2024-10-21"

/** The first version with GPT Image; v1 does not route FLUX.1 Kontext edits. */
const IMAGE_API_VERSION = "2025-04-01-preview"

/**
 * The audience every Foundry call accepts: project discovery refuses a token for
 * cognitiveservices.azure.com, which model calls also accept (measured November 2026).
 */
const ENTRA_SCOPE = "https://ai.azure.com/.default"

/**
 * Token renewal follows Azure's own token cycler (`@azure/core-rest-pipeline`): renew in the
 * background from the credential's refresh hint or two minutes before expiry, keep the current
 * token while a renewal fails, and wait only for a missing or expiring one.
 */
const RENEW_BEFORE_EXPIRY_MS = 2 * 60_000
const EXPIRING_MS = 1_000
const RENEW_RETRY_MS = 3_000
/** Bounds one getToken call, so one that never settles cannot hold every later call. */
const TOKEN_TIMEOUT_MS = 30_000

/** Entra ID sign-in, such as `DefaultAzureCredential` or `ManagedIdentityCredential` from `@azure/identity`. */
export interface AzureAIFoundryCredential {
  getToken(
    scopes: string | string[],
    options?: { readonly abortSignal?: AbortSignal }
  ): Promise<{
    readonly token: string
    readonly expiresOnTimestamp?: number
    readonly refreshAfterTimestamp?: number
  } | null>
}

export interface TransportOptions {
  readonly endpoint: string
  /** The project resource's key, sent as `api-key` (`x-api-key` to Messages). */
  readonly apiKey?: ValueSource<string | undefined>
  /** Entra ID in place of a key: a bearer token for every call, renewed before it expires. */
  readonly credential?: AzureAIFoundryCredential
  readonly headers?: ValueSource<Readonly<Record<string, string>>>
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  readonly maxRetries?: number
  readonly maxRetryDelayMs?: number
}

/**
 * The project URL says what is deployed; every model call goes to the resource that owns the
 * project. The project's own inference path answers through another service that trails new
 * models: for gpt-6.2-sol it refused reasoning efforts, ignored tools and reported no input
 * tokens, where the resource answered all three (measured November 2026).
 */
export class FoundryTransport {
  private readonly diagnostics = new WeakMap<Response, RequestDiagnostics>()
  /** Deployment discovery: `https://<resource>.services.ai.azure.com/api/projects/<project>`. */
  readonly projectUrl: string
  /** Every model call: the project URL's origin. */
  readonly resourceUrl: string
  private readonly options: TransportOptions
  private token?: { readonly value: string; readonly expiresAt: number; readonly renewAt: number }
  private renewal?: Promise<string>

  constructor(options: TransportOptions) {
    if (!URL.canParse(options.endpoint))
      throw new TypeError(`${PREFIX} endpoint must be a valid project URL.`)
    const url = new URL(options.endpoint)
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new TypeError(
        `${PREFIX} endpoint must be an HTTP(S) project URL without credentials, query, or fragment.`
      )
    }
    const path = url.pathname.replace(/\/+$/, "")
    if (!/^\/api\/projects\/[^/]+$/.test(path))
      throw new TypeError(
        `${PREFIX} endpoint must be a Foundry project URL: https://<resource>.services.ai.azure.com/api/projects/<project>.`
      )
    this.projectUrl = `${url.origin}${path}`
    this.resourceUrl = url.origin
    if (options.credential !== undefined) {
      if (options.apiKey !== undefined)
        throw new TypeError(`${PREFIX} Configure either apiKey or credential, not both.`)
      if (typeof options.credential?.getToken !== "function")
        throw new TypeError(
          `${PREFIX} credential must have a getToken method, such as DefaultAzureCredential from @azure/identity.`
        )
    } else if (
      typeof options.apiKey !== "function" &&
      (typeof options.apiKey !== "string" || !options.apiKey.trim())
    )
      throw new TypeError(`${PREFIX} apiKey or credential is required.`)
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
    body: string | FormData,
    signal: AbortSignal,
    providerId: string,
    modelId: string,
    protocol: FoundryRoute = "responses"
  ): Promise<Response> {
    const url = this.url(protocol, modelId)
    const diagnostics = new RequestDiagnostics()
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted()
      const headers = await this.headers(
        signal,
        diagnostics,
        protocol === "messages" ? "x-api-key" : "api-key"
      )
      // fetch writes a multipart body's content type, boundary included.
      if (typeof body === "string") headers.set("content-type", "application/json")
      else headers.delete("content-type")
      // Speech streams its audio as events: the only stream that reports usage.
      headers.set(
        "accept",
        ONE_SHOT.has(protocol) && protocol !== "speech" ? "application/json" : "text/event-stream"
      )
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
      // One-shot routes: the caller decides, from `retryable`, whether to replay.
      if (ONE_SHOT.has(protocol) || !error.retryable || attempt >= (this.options.maxRetries ?? 2))
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
        throw new TypeError(`${PREFIX} Use apiKey or credential instead of '${reserved}' headers.`)
    if (this.options.credential) {
      const token = await this.bearerToken(signal)
      diagnostics.add(token)
      headers.set("authorization", `Bearer ${token}`)
      return headers
    }
    const key = await resolve(this.options.apiKey, signal)
    if (typeof key !== "string" || !key.trim())
      throw new TypeError(
        `${PREFIX} apiKey must resolve to a nonempty string: pass apiKey or credential, or set AZURE_AI_FOUNDRY_API_KEY.`
      )
    diagnostics.add(key)
    headers.set(keyHeader, key)
    return headers
  }

  /** One token for every call; a call waits only when there is none, or it is about to expire. */
  private bearerToken(signal: AbortSignal): Promise<string> {
    const token = this.token
    const now = Date.now()
    if (!token || now >= token.expiresAt - EXPIRING_MS)
      return abortable(() => this.renewToken(), signal)
    if (now >= token.renewAt)
      this.renewToken().catch(() => {
        // The current token still works; try again shortly, or when it expires.
        if (this.token === token) this.token = { ...token, renewAt: Date.now() + RENEW_RETRY_MS }
      })
    return Promise.resolve(token.value)
  }

  /** Concurrent callers share one getToken call. */
  private renewToken(): Promise<string> {
    this.renewal ??= (async () => {
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error(`${PREFIX} credential.getToken timed out.`)),
        TOKEN_TIMEOUT_MS
      )
      try {
        const signal = controller.signal
        const token = await abortable(
          () => this.options.credential!.getToken(ENTRA_SCOPE, { abortSignal: signal }),
          signal
        )
        if (typeof token?.token !== "string" || !token.token.trim())
          throw new TypeError(`${PREFIX} credential returned no token for ${ENTRA_SCOPE}.`)
        // A token without an expiry is not reused: the credential's own cache decides.
        const expiresAt = token.expiresOnTimestamp ?? 0
        this.token = {
          value: token.token,
          expiresAt,
          renewAt: Math.min(
            token.refreshAfterTimestamp ?? expiresAt,
            expiresAt - RENEW_BEFORE_EXPIRY_MS
          ),
        }
        return token.token
      } finally {
        clearTimeout(timer)
        this.renewal = undefined
      }
    })()
    return this.renewal
  }

  fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(url, init)
  }

  url(protocol: FoundryRoute, deployment?: string): string {
    const resource = this.resourceUrl
    const path = encodeURIComponent(deployment ?? "")
    // Audio and image deployments answer by deployment path, at the versions noted above.
    if (protocol === "transcription")
      return `${resource}/openai/deployments/${path}/audio/transcriptions?api-version=${AUDIO_API_VERSION}`
    if (protocol === "image" || protocol === "image-edit")
      return `${resource}/openai/deployments/${path}/images/${protocol === "image" ? "generations" : "edits"}?api-version=${IMAGE_API_VERSION}`
    if (protocol === "decision") return `${resource}/providers/microsoft/v1/systemone`
    // Cohere rerankers answer Cohere's v2 API.
    if (protocol === "reranking") return `${resource}/providers/cohere/v2/rerank`
    if (protocol === "messages") return `${resource}/anthropic/v1/messages`
    if (protocol === "embeddings") return `${resource}/openai/v1/embeddings`
    if (protocol === "speech") return `${resource}/openai/v1/audio/speech`
    if (protocol === "chat") return `${resource}/openai/v1/chat/completions`
    return `${resource}/openai/v1/responses`
  }
}

/** Read a JSON body up to `maxBytes`; the reader is released on success, failure or abort. */
export async function readJson(
  response: Response,
  signal: AbortSignal,
  maxBytes: number
): Promise<unknown> {
  return JSON.parse(await readText(response, signal, maxBytes))
}

/** Read a body as UTF-8 up to `maxBytes`; the reader is released on success, failure or abort. */
export async function readText(
  response: Response,
  signal: AbortSignal,
  maxBytes: number
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Empty response")
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await abortable(() => reader.read(), signal)
      if (chunk.done) break
      bytes += chunk.value.length
      if (bytes > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`)
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks).toString("utf8")
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
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
      // Decision models reject some requests with `{ "detail": "..." }` instead of `error`.
      const detail = object(parsed)?.detail
      if (typeof error?.message === "string") message = error.message
      else if (typeof detail === "string") message = detail
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
    ...contextWindowRejection({ status: response.status, code, message }),
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
