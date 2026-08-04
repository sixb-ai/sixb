import type { AgentToolDefinition, ConnectorDefinition } from "@sixb/core"
import { AgentToolPublicError, defineAgentTool, type JsonValue } from "@sixb/core"
import { type ExaSearchDomainPolicy, resolveExaSearchDomainPolicy } from "./search-domain-policy"
import { waitForSignal } from "./signals"
import type { ExaConnector, ExaSearchRequest, ExaSearchResponse } from "./types"

const DEFAULT_MAX_RESULTS = 5
const DEFAULT_MAX_CHARACTERS_PER_RESULT = 2_000
const DEFAULT_MAX_TOTAL_CHARACTERS = 10_000
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_RESULTS = 100
const MAX_QUERY_CHARACTERS = 2_000
const MAX_TITLE_CHARACTERS = 500
const MAX_URL_CHARACTERS = 4_096
const MAX_AUTHOR_CHARACTERS = 300
const MAX_PUBLISHED_DATE_CHARACTERS = 100
const MAX_REQUEST_ID_CHARACTERS = 200

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

interface ResolvedExaWebSearchOptions {
  readonly maxResults: number
  readonly maxCharactersPerResult: number
  readonly maxTotalCharacters: number
  readonly timeoutMs: number
  readonly domainPolicy: ExaSearchDomainPolicy
}

/** Create a provider-neutral, bounded `web_search` tool backed by an Exa connector. */
export function exaWebSearch(
  connectorDefinition: ConnectorDefinition<string, ExaConnector>,
  options: ExaWebSearchOptions = {}
): ExaWebSearchTool {
  const limits = resolveOptions(options)

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

function resolveOptions(options: ExaWebSearchOptions): ResolvedExaWebSearchOptions {
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
