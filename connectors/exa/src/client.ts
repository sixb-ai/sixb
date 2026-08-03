import type { RestClient } from "@sixb/connector-rest"
import { ExaApiError } from "./errors"
import { parseExaContentsResponse, parseExaSearchResponse } from "./response"
import { waitForSignal } from "./signals"
import type {
  ExaApiKeyResolver,
  ExaClient,
  ExaContentsRequest,
  ExaContentsResponse,
  ExaErrorResponse,
  ExaRequestOptions,
  ExaSearchRequest,
  ExaSearchResponse,
} from "./types"

const MAX_DOMAINS = 1_200
const MAX_RESULTS = 100
const MAX_CONTENT_URLS = 100
const MAX_CONTENT_URL_CHARACTERS = 2_048
const MAX_SUBPAGES = 100
const MAX_ERROR_MESSAGE_CHARACTERS = 500
const MAX_ERROR_METADATA_CHARACTERS = 200

type ExaOperation = "search" | "contents"

export function createExaClient(
  http: RestClient,
  apiKey: ExaApiKeyResolver,
  connectionSignal: AbortSignal
): ExaClient {
  return {
    async search(
      request: ExaSearchRequest,
      options: ExaRequestOptions = {}
    ): Promise<ExaSearchResponse> {
      assertSearchRequest(request)
      return requestExa(
        http,
        apiKey,
        connectionSignal,
        "search",
        request,
        options,
        parseExaSearchResponse
      )
    },
    async getContents(
      request: ExaContentsRequest,
      options: ExaRequestOptions = {}
    ): Promise<ExaContentsResponse> {
      assertContentsRequest(request)
      return requestExa(
        http,
        apiKey,
        connectionSignal,
        "contents",
        request,
        options,
        parseExaContentsResponse
      )
    },
  }
}

function requestExa<T>(
  http: RestClient,
  apiKey: ExaApiKeyResolver,
  connectionSignal: AbortSignal,
  operationName: ExaOperation,
  body: unknown,
  options: ExaRequestOptions,
  parse: (value: unknown, status?: number) => T
): Promise<T> {
  const signal = options.signal
    ? AbortSignal.any([connectionSignal, options.signal])
    : connectionSignal
  signal.throwIfAborted()

  const operation = (async (): Promise<T> => {
    const resolvedApiKey = await resolveApiKey(apiKey)
    signal.throwIfAborted()

    let response: Response
    try {
      response = await http.post(operationName, body, {
        headers: {
          accept: "application/json",
          "x-api-key": resolvedApiKey,
        },
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      throw new ExaApiError(`[SixbExa] Exa ${operationName} could not reach the API.`, {
        cause: error,
      })
    }

    if (!response.ok) {
      throw await apiErrorFromResponse(response, resolvedApiKey, operationName)
    }

    const value = await readJson(response, operationName)
    signal.throwIfAborted()
    return parse(value, response.status)
  })()

  return waitForSignal(operation, signal)
}

export function assertApiKeyResolver(apiKey: ExaApiKeyResolver): void {
  if (typeof apiKey === "string") {
    if (!apiKey.trim()) throw new Error("[SixbExa] apiKey must not be empty.")
    return
  }
  if (typeof apiKey !== "function") {
    throw new Error("[SixbExa] apiKey must be a string or a function.")
  }
}

async function resolveApiKey(apiKey: ExaApiKeyResolver): Promise<string> {
  let value: string
  try {
    value = typeof apiKey === "function" ? await apiKey() : apiKey
  } catch {
    throw new ExaApiError("[SixbExa] Could not resolve apiKey.")
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new ExaApiError("[SixbExa] Resolved apiKey must not be empty.")
  }
  // Headers normalize surrounding HTTP whitespace. Use that exact wire value for both the request
  // and provider-error redaction so a padded configuration can never bypass secret scrubbing.
  return value.trim()
}

function assertSearchRequest(request: ExaSearchRequest): void {
  if (!request || typeof request !== "object") {
    throw new Error("[SixbExa] search request must be an object.")
  }
  if (typeof request.query !== "string" || !request.query.trim()) {
    throw new Error("[SixbExa] search query must not be empty.")
  }
  if (request.numResults !== undefined) {
    assertIntegerInRange(request.numResults, "numResults", 1, MAX_RESULTS)
  }
  assertDomains(request.includeDomains, "includeDomains")
  assertDomains(request.excludeDomains, "excludeDomains")

  if (request.contents !== undefined && !isRecord(request.contents)) {
    throw new Error("[SixbExa] contents must be an object.")
  }
  const text = request.contents?.text
  if (text !== undefined && text !== true) {
    if (!isRecord(text)) {
      throw new Error("[SixbExa] contents.text must be true or an options object.")
    }
    if (text.maxCharacters !== undefined) {
      assertPositiveSafeInteger(text.maxCharacters, "contents.text.maxCharacters")
    }
    if (text.includeHtmlTags !== undefined && typeof text.includeHtmlTags !== "boolean") {
      throw new Error("[SixbExa] contents.text.includeHtmlTags must be a boolean.")
    }
  }
}

function assertContentsRequest(request: ExaContentsRequest): void {
  if (!request || typeof request !== "object") {
    throw new Error("[SixbExa] contents request must be an object.")
  }
  if (
    !Array.isArray(request.urls) ||
    request.urls.length < 1 ||
    request.urls.length > MAX_CONTENT_URLS
  ) {
    throw new Error(`[SixbExa] contents urls must contain from 1 to ${MAX_CONTENT_URLS} URLs.`)
  }
  for (const url of request.urls) {
    if (
      typeof url !== "string" ||
      !url.trim() ||
      url.length > MAX_CONTENT_URL_CHARACTERS ||
      !isHttpUrl(url)
    ) {
      throw new Error(
        `[SixbExa] contents urls entries must be absolute HTTP(S) URLs with at most ${MAX_CONTENT_URL_CHARACTERS} characters.`
      )
    }
  }

  const text = request.text
  if (text !== undefined && text !== true) {
    if (!isRecord(text)) {
      throw new Error("[SixbExa] contents text must be true or an options object.")
    }
    if (text.maxCharacters !== undefined) {
      assertPositiveSafeInteger(text.maxCharacters, "contents.text.maxCharacters")
    }
    if (text.includeHtmlTags !== undefined && typeof text.includeHtmlTags !== "boolean") {
      throw new Error("[SixbExa] contents text.includeHtmlTags must be a boolean.")
    }
  }

  if (request.subpages !== undefined) {
    assertIntegerInRange(request.subpages, "contents.subpages", 0, MAX_SUBPAGES)
  }
}

function assertDomains(domains: readonly string[] | undefined, field: string): void {
  if (domains === undefined) return
  if (!Array.isArray(domains) || domains.length > MAX_DOMAINS) {
    throw new Error(`[SixbExa] ${field} must contain at most ${MAX_DOMAINS} domains.`)
  }
  for (const domain of domains) {
    if (typeof domain !== "string" || !domain.trim()) {
      throw new Error(`[SixbExa] ${field} entries must be non-empty strings.`)
    }
  }
}

function assertIntegerInRange(value: number, field: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`[SixbExa] ${field} must be an integer from ${min} to ${max}.`)
  }
}

function assertPositiveSafeInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`[SixbExa] ${field} must be a positive safe integer.`)
  }
}

async function apiErrorFromResponse(
  response: Response,
  apiKey: string,
  operation: ExaOperation
): Promise<ExaApiError> {
  const body = await readOptionalJson(response)
  const error = errorResponseFrom(body)
  const tag = sanitizeAndTruncate(error?.tag, apiKey, MAX_ERROR_METADATA_CHARACTERS)
  const requestId = sanitizeAndTruncate(error?.requestId, apiKey, MAX_ERROR_METADATA_CHARACTERS)
  const providerMessage = sanitizeAndTruncate(error?.error, apiKey, MAX_ERROR_MESSAGE_CHARACTERS)
  const details = [
    tag ? ` (${tag})` : "",
    providerMessage ? `: ${providerMessage}` : "",
    requestId ? ` (requestId: ${requestId})` : "",
  ].join("")

  return new ExaApiError(
    `[SixbExa] Exa ${operation} failed with HTTP ${response.status}${details}.`,
    {
      status: response.status,
      ...(tag ? { tag } : {}),
      ...(requestId ? { requestId } : {}),
    }
  )
}

async function readJson(response: Response, operation: ExaOperation): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw new ExaApiError(`[SixbExa] Exa ${operation} response could not be read.`, {
      status: response.status,
      cause: error,
    })
  }
  if (!text) {
    throw new ExaApiError(`[SixbExa] Exa ${operation} returned an empty response.`, {
      status: response.status,
    })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ExaApiError(`[SixbExa] Exa ${operation} returned invalid JSON.`, {
      status: response.status,
    })
  }
}

async function readOptionalJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "")
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function errorResponseFrom(value: unknown): ExaErrorResponse | undefined {
  if (!isRecord(value)) return undefined
  return {
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.tag === "string" ? { tag: value.tag } : {}),
  }
}

function sanitizeAndTruncate(
  value: string | undefined,
  apiKey: string,
  maxCharacters: number
): string | undefined {
  if (value === undefined) return undefined
  return truncate(value.split(apiKey).join("[REDACTED]"), maxCharacters)
}

function truncate(value: string, maxCharacters: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length <= maxCharacters ? collapsed : `${collapsed.slice(0, maxCharacters)}…`
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
