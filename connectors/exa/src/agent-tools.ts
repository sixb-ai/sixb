import type { AgentToolDefinition, ConnectorDefinition } from "@sixb/core"
import { AgentToolPublicError, defineAgentTool, type JsonValue } from "@sixb/core"
import { type ExaSearchDomainPolicy, resolveExaSearchDomainPolicy } from "./search-domain-policy"
import { waitForSignal } from "./signals"
import type {
  ExaConnector,
  ExaContentsRequest,
  ExaContentsResponse,
  ExaContentsStatus,
  ExaSearchRequest,
  ExaSearchResponse,
} from "./types"

const DEFAULT_MAX_RESULTS = 5
const DEFAULT_MAX_CHARACTERS_PER_RESULT = 2_000
const DEFAULT_MAX_TOTAL_CHARACTERS = 10_000
const DEFAULT_MAX_FETCH_CHARACTERS = 10_000
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_RESULTS = 100
const MAX_DOMAINS = 1_200
const MAX_QUERY_CHARACTERS = 2_000
const MAX_TITLE_CHARACTERS = 500
const MAX_URL_CHARACTERS = 4_096
const MAX_AUTHOR_CHARACTERS = 300
const MAX_PUBLISHED_DATE_CHARACTERS = 100
const MAX_REQUEST_ID_CHARACTERS = 200
const MAX_INPUT_URL_CHARACTERS = 2_048
const MAX_STATUS_CHARACTERS = 100

export interface ExaWebSearchOptions {
  /** Maximum provider results requested and returned. Defaults to 5; Exa allows at most 100. */
  readonly maxResults?: number
  /** Maximum text characters returned for any one result. Defaults to 2,000. */
  readonly maxCharactersPerResult?: number
  /** Maximum text characters returned across all results. Defaults to 10,000. */
  readonly maxTotalCharacters?: number
  /** Overall connector resolution and provider-request timeout. Defaults to 20 seconds. */
  readonly timeoutMs?: number
  /** Exa domain or path filters to include. An explicitly empty allowlist is rejected. */
  readonly allowedDomains?: readonly string[]
  /** Exa domain or path filters to exclude. */
  readonly deniedDomains?: readonly string[]
}

export interface ExaWebSearchResult {
  readonly title: string
  readonly url: string
  readonly author?: string
  readonly publishedDate?: string
  readonly text: string
}

export interface ExaWebSearchOutput {
  readonly results: readonly ExaWebSearchResult[]
  readonly requestId?: string
  readonly costDollars?: {
    readonly total: number
  }
}

export type ExaWebSearchTool = AgentToolDefinition<"web_search", { readonly query: "string" }>

export interface ExaWebFetchOptions {
  /** Maximum page-text characters requested and returned. Defaults to 10,000. */
  readonly maxCharacters?: number
  /** Overall connector resolution and provider-request timeout. Defaults to 20 seconds. */
  readonly timeoutMs?: number
  /** Hostnames the requested and returned page may use. Subdomains are included. */
  readonly allowedDomains?: readonly string[]
  /** Hostnames the requested and returned page may not use. Denials take precedence. */
  readonly deniedDomains?: readonly string[]
}

export type ExaWebFetchStatus = {
  readonly status: string
  readonly source?: string
}

export interface ExaWebFetchOutput {
  readonly title: string
  readonly url: string
  readonly content: string
  readonly status?: ExaWebFetchStatus
  readonly requestId?: string
  readonly costDollars?: {
    readonly total: number
  }
}

export type ExaWebFetchTool = AgentToolDefinition<"web_fetch", { readonly url: "string" }>

interface ResolvedExaWebSearchOptions {
  readonly maxResults: number
  readonly maxCharactersPerResult: number
  readonly maxTotalCharacters: number
  readonly timeoutMs: number
  readonly domainPolicy: ExaSearchDomainPolicy
}

interface ResolvedExaWebFetchOptions {
  readonly maxCharacters: number
  readonly timeoutMs: number
  readonly allowedDomains?: readonly string[]
  readonly deniedDomains?: readonly string[]
}

/** Create a provider-neutral, bounded `web_search` tool backed by an Exa connector. */
export function exaWebSearch(
  connectorDefinition: ConnectorDefinition<string, ExaConnector>,
  options: ExaWebSearchOptions = {}
): ExaWebSearchTool {
  const limits = resolveSearchOptions(options)

  return defineAgentTool("web_search")
    .description("Search the web and return bounded source text with URLs and metadata.")
    .input({ query: "string" })
    .run(async ({ input, connector, signal: runSignal }) => {
      const query = input.query.trim()
      if (!query) {
        throw new AgentToolPublicError("[SixbExa] web_search query must not be empty.")
      }
      if (query.length > MAX_QUERY_CHARACTERS) {
        throw new AgentToolPublicError(
          `[SixbExa] web_search query must contain at most ${MAX_QUERY_CHARACTERS} characters.`
        )
      }

      const timeoutSignal = AbortSignal.timeout(limits.timeoutMs)
      const signal = AbortSignal.any([runSignal, timeoutSignal])
      const request: ExaSearchRequest = {
        query,
        numResults: limits.maxResults,
        contents: {
          text: {
            maxCharacters: Math.min(limits.maxCharactersPerResult, limits.maxTotalCharacters),
          },
        },
        ...(limits.domainPolicy.includeDomains
          ? { includeDomains: limits.domainPolicy.includeDomains }
          : {}),
        ...(limits.domainPolicy.excludeDomains
          ? { excludeDomains: limits.domainPolicy.excludeDomains }
          : {}),
      }

      try {
        signal.throwIfAborted()
        const response = await waitForSignal(
          (async () => {
            const client = await connector(connectorDefinition)
            return client.search(request, { signal })
          })(),
          signal
        )
        signal.throwIfAborted()
        return normalizeOutput(response, limits)
      } catch (error) {
        if (runSignal.aborted) throw runSignal.reason ?? error
        if (timeoutSignal.aborted) {
          throw new AgentToolPublicError(
            `[SixbExa] web_search timed out after ${limits.timeoutMs}ms.`,
            { cause: error }
          )
        }
        throw error
      }
    })
}

/** Create a provider-neutral, single-page `web_fetch` tool backed by an Exa connector. */
export function exaWebFetch(
  connectorDefinition: ConnectorDefinition<string, ExaConnector>,
  options: ExaWebFetchOptions = {}
): ExaWebFetchTool {
  const limits = resolveFetchOptions(options)

  return defineAgentTool("web_fetch")
    .description("Fetch one web page and return bounded source content with its URL and metadata.")
    .input({ url: "string" })
    .run(async ({ input, connector, signal: runSignal }) => {
      const requestedUrl = normalizeFetchUrl(input.url)
      assertDomainPolicy(requestedUrl, limits)

      const timeoutSignal = AbortSignal.timeout(limits.timeoutMs)
      const signal = AbortSignal.any([runSignal, timeoutSignal])
      const request: ExaContentsRequest = {
        urls: [requestedUrl.toString()],
        text: { maxCharacters: limits.maxCharacters },
        subpages: 0,
      }

      try {
        signal.throwIfAborted()
        const response = await waitForSignal(
          (async () => {
            const client = await connector(connectorDefinition)
            return client.getContents(request, { signal })
          })(),
          signal
        )
        signal.throwIfAborted()
        return normalizeFetchOutput(response, requestedUrl, limits)
      } catch (error) {
        if (runSignal.aborted) throw runSignal.reason ?? error
        if (timeoutSignal.aborted) {
          throw new Error(`[SixbExa] web_fetch timed out after ${limits.timeoutMs}ms.`, {
            cause: error,
          })
        }
        throw error
      }
    })
}

function normalizeOutput(
  response: ExaSearchResponse,
  limits: ResolvedExaWebSearchOptions
): JsonValue {
  let remainingCharacters = limits.maxTotalCharacters
  const results = response.results.slice(0, limits.maxResults).flatMap((result) => {
    const resultUrl = normalizeResultUrl(result.url)
    if (!resultUrl) return []
    limits.domainPolicy.assertAllows(resultUrl.parsed)
    const url = resultUrl.value

    const availableCharacters = Math.min(limits.maxCharactersPerResult, remainingCharacters)
    const text = (result.text ?? "").slice(0, availableCharacters)
    remainingCharacters -= text.length
    const title = truncate(result.title?.trim() || url, MAX_TITLE_CHARACTERS)
    const author = normalizeOptionalString(result.author, MAX_AUTHOR_CHARACTERS)
    const publishedDate = normalizeOptionalString(
      result.publishedDate,
      MAX_PUBLISHED_DATE_CHARACTERS
    )

    return [
      {
        title,
        url,
        ...(author ? { author } : {}),
        ...(publishedDate ? { publishedDate } : {}),
        text,
      },
    ]
  })
  const requestId = normalizeOptionalString(response.requestId, MAX_REQUEST_ID_CHARACTERS)

  const output = {
    results,
    ...(requestId ? { requestId } : {}),
    ...(response.costDollars ? { costDollars: { total: response.costDollars.total } } : {}),
  } satisfies ExaWebSearchOutput
  return output
}

function resolveSearchOptions(options: ExaWebSearchOptions): ResolvedExaWebSearchOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("[SixbExa] web_search options must be an object.")
  }

  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS
  assertIntegerInRange(maxResults, "maxResults", 1, MAX_RESULTS)
  const maxCharactersPerResult = options.maxCharactersPerResult ?? DEFAULT_MAX_CHARACTERS_PER_RESULT
  assertPositiveSafeInteger(maxCharactersPerResult, "maxCharactersPerResult")
  const maxTotalCharacters = options.maxTotalCharacters ?? DEFAULT_MAX_TOTAL_CHARACTERS
  assertPositiveSafeInteger(maxTotalCharacters, "maxTotalCharacters")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertPositiveSafeInteger(timeoutMs, "timeoutMs")
  const domainPolicy = resolveExaSearchDomainPolicy({
    allowedDomains: options.allowedDomains,
    deniedDomains: options.deniedDomains,
  })

  return {
    maxResults,
    maxCharactersPerResult,
    maxTotalCharacters,
    timeoutMs,
    domainPolicy,
  }
}

function normalizeFetchOutput(
  response: ExaContentsResponse,
  requestedUrl: URL,
  limits: ResolvedExaWebFetchOptions
): JsonValue {
  const status =
    response.statuses?.find((item) => item.id === requestedUrl.toString()) ?? response.statuses?.[0]
  if (status?.error || status?.status.toLowerCase() === "error") {
    throw contentsStatusError(status)
  }

  const result = response.results[0]
  if (!result || !result.text?.trim()) {
    throw new Error("[SixbExa] web_fetch returned no content for the requested URL.")
  }

  const resultUrl = normalizeReturnedUrl(result.url)
  assertDomainPolicy(resultUrl, limits, true)
  const title = truncate(result.title?.trim() || resultUrl.toString(), MAX_TITLE_CHARACTERS)
  const content = result.text.slice(0, limits.maxCharacters)
  const normalizedStatus = normalizeFetchStatus(status)
  const requestId = normalizeOptionalString(response.requestId, MAX_REQUEST_ID_CHARACTERS)

  const output = {
    title,
    url: resultUrl.toString(),
    content,
    ...(normalizedStatus ? { status: normalizedStatus } : {}),
    ...(requestId ? { requestId } : {}),
    ...(response.costDollars ? { costDollars: { total: response.costDollars.total } } : {}),
  } satisfies ExaWebFetchOutput
  return output
}

function resolveFetchOptions(options: ExaWebFetchOptions): ResolvedExaWebFetchOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("[SixbExa] web_fetch options must be an object.")
  }

  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_FETCH_CHARACTERS
  assertPositiveSafeInteger(maxCharacters, "maxCharacters")
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertPositiveSafeInteger(timeoutMs, "timeoutMs")

  return {
    maxCharacters,
    timeoutMs,
    ...(options.allowedDomains !== undefined
      ? { allowedDomains: normalizeHostnames(options.allowedDomains, "allowedDomains") }
      : {}),
    ...(options.deniedDomains !== undefined
      ? { deniedDomains: normalizeHostnames(options.deniedDomains, "deniedDomains") }
      : {}),
  }
}

function normalizeHostnames(hostnames: readonly string[], field: string): readonly string[] {
  if (!Array.isArray(hostnames) || hostnames.length < 1 || hostnames.length > MAX_DOMAINS) {
    throw new Error(`[SixbExa] ${field} must contain from 1 to ${MAX_DOMAINS} domains.`)
  }

  return hostnames.map((value) => {
    if (typeof value !== "string") throw invalidHostnameError(field)
    const hostname = canonicalHostname(value.trim())
    if (!hostname || hostname.length > 253 || /[/:?#@]/.test(hostname) || hostname.includes("*")) {
      throw invalidHostnameError(field)
    }
    try {
      const parsed = new URL(`https://${hostname}`)
      if (canonicalHostname(parsed.hostname) !== hostname || parsed.pathname !== "/") {
        throw invalidHostnameError(field)
      }
      return canonicalHostname(parsed.hostname)
    } catch {
      throw invalidHostnameError(field)
    }
  })
}

function invalidHostnameError(field: string): Error {
  return new Error(`[SixbExa] ${field} entries must be hostnames without ports or paths.`)
}

function assertIntegerInRange(value: number, field: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`[SixbExa] ${field} must be an integer from ${min} to ${max}.`)
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`[SixbExa] ${field} must be a positive safe integer.`)
  }
}

function normalizeResultUrl(
  value: string
): { readonly value: string; readonly parsed: URL } | undefined {
  const url = value.trim()
  if (!url || url.length > MAX_URL_CHARACTERS) return undefined
  try {
    const parsed = new URL(url)
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return undefined
    }
    return { value: url, parsed }
  } catch {
    return undefined
  }
}

function normalizeFetchUrl(value: string): URL {
  const url = value.trim()
  if (!url) throw new Error("[SixbExa] web_fetch URL must not be empty.")
  if (url.length > MAX_INPUT_URL_CHARACTERS) {
    throw new Error(
      `[SixbExa] web_fetch URL must contain at most ${MAX_INPUT_URL_CHARACTERS} characters.`
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("[SixbExa] web_fetch URL must be an absolute HTTP(S) URL.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("[SixbExa] web_fetch URL must be an absolute HTTP(S) URL.")
  }
  if (parsed.username || parsed.password) {
    throw new Error("[SixbExa] web_fetch URL must not contain credentials.")
  }
  if (parsed.toString().length > MAX_INPUT_URL_CHARACTERS) {
    throw new Error(
      `[SixbExa] web_fetch URL must contain at most ${MAX_INPUT_URL_CHARACTERS} characters.`
    )
  }
  return parsed
}

function normalizeReturnedUrl(value: string): URL {
  if (value.trim().length > MAX_URL_CHARACTERS) {
    throw new Error("[SixbExa] web_fetch returned an invalid URL.")
  }
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error("[SixbExa] web_fetch returned an invalid URL.")
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("[SixbExa] web_fetch returned an invalid URL.")
  }
  return url
}

function assertDomainPolicy(url: URL, limits: ResolvedExaWebFetchOptions, returned = false): void {
  const hostname = canonicalHostname(url.hostname)
  if (limits.deniedDomains?.some((domain) => domainMatches(hostname, domain))) {
    const subject = returned ? "returned domain" : "domain"
    throw new Error(`[SixbExa] web_fetch denied ${subject} "${hostname}".`)
  }
  if (
    limits.allowedDomains &&
    !limits.allowedDomains.some((domain) => domainMatches(hostname, domain))
  ) {
    const subject = returned ? "returned domain" : "domain"
    throw new Error(`[SixbExa] web_fetch ${subject} "${hostname}" is not allowed.`)
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`)
}

function canonicalHostname(value: string): string {
  return value.toLowerCase().replace(/\.$/, "")
}

function contentsStatusError(status: ExaContentsStatus): Error {
  const tag = normalizeOptionalString(status.error?.tag, MAX_STATUS_CHARACTERS)
  const statusName = normalizeOptionalString(status.status, MAX_STATUS_CHARACTERS)
  const label = tag ?? statusName ?? "an unknown error"
  const httpStatusCode = status.error?.httpStatusCode
  const http =
    httpStatusCode === undefined || httpStatusCode === null ? "" : ` (HTTP ${httpStatusCode})`
  return new Error(`[SixbExa] web_fetch provider reported ${label}${http}.`)
}

function normalizeFetchStatus(
  status: ExaContentsStatus | undefined
): ExaWebFetchStatus | undefined {
  if (!status) return undefined
  const statusName = normalizeOptionalString(status.status, MAX_STATUS_CHARACTERS)
  if (!statusName) return undefined
  const source = normalizeOptionalString(status.source, MAX_STATUS_CHARACTERS)
  return {
    status: statusName,
    ...(source ? { source } : {}),
  }
}

function normalizeOptionalString(
  value: string | null | undefined,
  maxCharacters: number
): string | undefined {
  const normalized = value?.trim()
  return normalized ? truncate(normalized, maxCharacters) : undefined
}

function truncate(value: string, maxCharacters: number): string {
  return value.slice(0, maxCharacters)
}
