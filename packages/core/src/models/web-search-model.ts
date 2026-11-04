import type { ModelDefinition } from "./definitions"
import { ModelProviderError } from "./errors"
import type { ModelProviderIds, ModelRoute, ModelUsage } from "./events"
import type { ModelCostEstimator, ModelMoney, ModelReportedCost } from "./pricing"

export interface WebSearchModelDefinition extends ModelDefinition {
  readonly kind: "web-search"
}

export interface WebSearchModelRequest {
  readonly query: string
  /** How many results to return; Sixb clamps it to 1–10. */
  readonly maxResults: number
  /** A hint for the provider; Sixb filters the results again. */
  readonly allowedDomains?: readonly string[]
  readonly blockedDomains?: readonly string[]
  readonly signal?: AbortSignal
}

/** One search result. Sixb cuts the snippet to 300 characters. */
export interface WebSearchHit {
  readonly url: string
  readonly title: string
  readonly snippet: string
  /** ISO 8601, when the provider knows when the page was published. */
  readonly publishedAt?: string
}

export interface WebSearchModelResponseMetadata {
  readonly usage?: ModelUsage
  readonly providerIds?: ModelProviderIds
  readonly responseModelId?: string
  readonly reportedCost?: ModelReportedCost
  readonly route?: ModelRoute
}

export interface WebSearchModelResult extends WebSearchModelResponseMetadata {
  readonly results: readonly WebSearchHit[]
}

export interface WebSearchCostEstimator extends Pick<ModelCostEstimator, "estimate"> {
  /** Return undefined if the search cannot be priced safely before it runs. */
  estimateReservation?(input: { readonly maxResults: number }): ModelMoney | undefined
}

/** Provider binding. Resolving it may fetch metadata, but must never run a search. */
export interface WebSearchModel {
  readonly providerId: string
  readonly modelId: string
  readonly definition: WebSearchModelDefinition
  readonly costEstimator?: WebSearchCostEstimator
  resolve?(): Promise<WebSearchModel>
  search(request: WebSearchModelRequest): Promise<WebSearchModelResult>
}

/** A billable reply Sixb could not read; its metadata is still recorded. */
export class WebSearchModelResponseError extends ModelProviderError {
  constructor(
    message: string,
    providerId: string,
    modelId: string,
    readonly metadata: WebSearchModelResponseMetadata,
    options?: { cause?: unknown }
  ) {
    super(message, providerId, modelId, {
      code: "invalid_web_search_response",
      retryable: false,
      cause: options?.cause,
    })
  }
}

/** The most results one search returns. */
export const MAX_WEB_SEARCH_RESULTS = 10

const SNIPPET_CHARACTERS = 300

export function assertWebSearchModel(model: WebSearchModel): void {
  if (
    !model ||
    typeof model !== "object" ||
    typeof model.search !== "function" ||
    !validIdentifier(model.providerId) ||
    !validIdentifier(model.modelId) ||
    model.definition?.kind !== "web-search" ||
    model.definition.providerId !== model.providerId ||
    model.definition.modelId !== model.modelId
  ) {
    throw new TypeError("[Sixb] Expected a WebSearchModel with a valid identity and search method.")
  }
}

/**
 * Check a provider's hits and keep at most `maxResults`: http(s) URLs, string titles and snippets,
 * snippets cut to 300 characters. A date that does not parse is dropped, the hit is kept.
 */
export function validateWebSearchHits(results: unknown, maxResults: number): WebSearchHit[] {
  if (!Array.isArray(results)) {
    throw new TypeError("[SixbModels] Web search must return a list of results.")
  }

  return results.slice(0, maxResults).map((result: unknown) => {
    if (!result || typeof result !== "object") {
      throw new TypeError("[SixbModels] Invalid web search result.")
    }

    const url: unknown = Reflect.get(result, "url")
    const title: unknown = Reflect.get(result, "title")
    const snippet: unknown = Reflect.get(result, "snippet")
    const publishedAt: unknown = Reflect.get(result, "publishedAt")
    if (
      !isWebUrl(url) ||
      typeof title !== "string" ||
      typeof snippet !== "string" ||
      (publishedAt !== undefined && typeof publishedAt !== "string")
    ) {
      throw new TypeError(
        "[SixbModels] Web search results need an http(s) url, a title and a snippet."
      )
    }

    const text = snippet.trim()
    const published = publishedAt === undefined ? Number.NaN : Date.parse(publishedAt)

    return {
      url,
      title: title.trim(),
      snippet: text.length > SNIPPET_CHARACTERS ? `${text.slice(0, SNIPPET_CHARACTERS)}…` : text,
      ...(Number.isNaN(published) ? {} : { publishedAt: new Date(published).toISOString() }),
    }
  })
}

function isWebUrl(value: unknown): value is string {
  if (typeof value !== "string") return false

  try {
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value
}
