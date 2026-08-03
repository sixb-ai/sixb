import type { ConnectorAdapter } from "@sixb/core"

export type ExaApiKeyResolver = string | (() => string | Promise<string>)

export interface ExaConnectorOptions {
  readonly apiKey: ExaApiKeyResolver
  readonly baseUrl?: string
}

export interface ExaRequestOptions {
  readonly signal?: AbortSignal
}

export interface ExaTextContentsOptions {
  readonly maxCharacters?: number
  readonly includeHtmlTags?: boolean
}

export interface ExaSearchContentsOptions {
  readonly text?: true | ExaTextContentsOptions
}

/** The supported wire fields for one Exa `/search` request. */
export interface ExaSearchRequest {
  readonly query: string
  readonly numResults?: number
  readonly includeDomains?: readonly string[]
  readonly excludeDomains?: readonly string[]
  readonly contents?: ExaSearchContentsOptions
}

/** One result returned by Exa's `/search` endpoint. */
export interface ExaSearchResult {
  readonly id: string
  readonly title: string | null
  readonly url: string
  readonly publishedDate?: string | null
  readonly author?: string | null
  readonly text?: string
}

/** Per-document status metadata present on some Exa responses. */
export interface ExaSearchStatus {
  readonly id: string
  readonly status: string
  readonly source: string
}

/** An endpoint-specific dollar-cost breakdown. */
export type ExaCostBreakdown = Readonly<Record<string, number>>

export interface ExaCostDollars {
  readonly total: number
  readonly search?: ExaCostBreakdown
  readonly contents?: ExaCostBreakdown
}

/** The non-streaming Exa `/search` response used by this connector. */
export interface ExaSearchResponse {
  readonly results: readonly ExaSearchResult[]
  readonly requestId?: string
  readonly statuses?: readonly ExaSearchStatus[]
  readonly costDollars?: ExaCostDollars
  readonly searchType?: string
  readonly resolvedSearchType?: string
  readonly searchTime?: number
}

/** The supported wire fields for one Exa `/contents` request. */
export interface ExaContentsRequest {
  readonly urls: readonly string[]
  readonly text?: true | ExaTextContentsOptions
  readonly subpages?: number
}

/** One document returned by Exa's `/contents` endpoint. */
export interface ExaContentsResult {
  readonly id: string
  readonly title: string | null
  readonly url: string
  readonly publishedDate?: string | null
  readonly author?: string | null
  readonly text?: string
}

export interface ExaContentsStatusError {
  readonly tag: string
  readonly httpStatusCode?: number | null
}

/** Per-document retrieval status returned by Exa's `/contents` endpoint. */
export interface ExaContentsStatus {
  readonly id: string
  readonly status: string
  readonly source?: string
  readonly error?: ExaContentsStatusError
}

/** The non-streaming Exa `/contents` response used by this connector. */
export interface ExaContentsResponse {
  readonly results: readonly ExaContentsResult[]
  readonly requestId?: string
  readonly statuses?: readonly ExaContentsStatus[]
  readonly costDollars?: ExaCostDollars
}

/** Structured fields Exa may return for a failed API request. */
export interface ExaErrorResponse {
  readonly requestId?: string
  readonly error?: string
  readonly tag?: string
}

export interface ExaClient {
  search(request: ExaSearchRequest, options?: ExaRequestOptions): Promise<ExaSearchResponse>
  getContents(
    request: ExaContentsRequest,
    options?: ExaRequestOptions
  ): Promise<ExaContentsResponse>
}

export type ExaConnector = ConnectorAdapter<"exa", ExaClient>
