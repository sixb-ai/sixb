import {
  ModelProviderError,
  type ModelReportedCost,
  type WebSearchHit,
  type WebSearchModel,
  type WebSearchModelRequest,
  WebSearchModelResponseError,
} from "@sixb/core/models"
import { createExaClient } from "./client"
import { ExaApiError } from "./errors"
import { exaRest } from "./exa"
import type {
  ExaConnectorOptions,
  ExaCostDollars,
  ExaSearchRequest,
  ExaSearchResult,
  ExaSearchType,
} from "./types"

export interface ExaSearchOptions extends ExaConnectorOptions {
  /** `auto` (default) picks the best search; `fast` trades some quality for latency. */
  readonly type?: ExaSearchType
  /** The most results one search returns, from 1 to 10. Defaults to 8. */
  readonly maxResults?: number
}

const PROVIDER_ID = "exa"
const DEFAULT_MAX_RESULTS = 8

// Measured: $0.007 for 8 results with highlights. Exa prices up to 10 results the same.
const RESERVATION = { currency: "USD", amountNanos: "10000000" } as const

/**
 * Make Exa the agent's web search: `models: { webSearch: [exaSearch({ apiKey })] }`. One search
 * is one Exa `/search` request, with the passages of each page that best match the query.
 */
export function exaSearch(options: ExaSearchOptions): WebSearchModel {
  const http = exaRest(options)

  const type = options.type ?? "auto"
  if (type !== "auto" && type !== "fast") {
    throw new TypeError('[SixbExa] exaSearch type must be "auto" or "fast".')
  }

  const ceiling = options.maxResults ?? DEFAULT_MAX_RESULTS
  if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 10) {
    throw new TypeError("[SixbExa] exaSearch maxResults must be an integer from 1 to 10.")
  }

  const modelId = type

  return Object.freeze({
    providerId: PROVIDER_ID,
    modelId,
    definition: Object.freeze({ kind: "web-search" as const, providerId: PROVIDER_ID, modelId }),
    costEstimator: Object.freeze({
      estimateReservation: () => RESERVATION,
      // No rate card prices a search: its cost is the one Exa reports.
      estimate: () => ({ status: "unpriceable" as const, reason: "missing-rate-card" as const }),
    }),

    async search(request: WebSearchModelRequest) {
      request.signal?.throwIfAborted()

      // Exa adds no headers or retries of its own, so the REST context only carries the signal.
      const signal = request.signal ?? new AbortController().signal
      const client = createExaClient(
        await http.connect({ projectId: "", connectorId: PROVIDER_ID, signal }),
        options.apiKey,
        signal
      )

      const body: ExaSearchRequest = {
        query: request.query,
        type,
        numResults: Math.min(request.maxResults, ceiling),
        contents: { highlights: true },
        ...domainFilter(request),
      }

      try {
        const response = await client.search(body, { signal })

        return {
          ...(response.requestId ? { providerIds: { requestId: response.requestId } } : {}),
          ...reportedCost(response.costDollars),
          // Core checks each hit and drops one without a web URL.
          results: response.results.map(hit),
        }
      } catch (error) {
        throw providerError(error, modelId)
      }
    },
  })
}

/**
 * The allowed domains when there are some, else the blocked ones: Exa takes one list, and Sixb
 * filters the results against both again.
 */
function domainFilter(
  request: WebSearchModelRequest
): Pick<ExaSearchRequest, "includeDomains" | "excludeDomains"> {
  if (request.allowedDomains?.length) return { includeDomains: request.allowedDomains }
  if (request.blockedDomains?.length) return { excludeDomains: request.blockedDomains }
  return {}
}

function hit(result: ExaSearchResult): WebSearchHit {
  return {
    url: result.url,
    title: result.title ?? "",
    snippet: result.highlights?.join(" … ") || result.text || "",
    ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
  }
}

function reportedCost(cost: ExaCostDollars | undefined): {
  readonly reportedCost?: ModelReportedCost
} {
  if (!cost) return {}

  const amountNanos = Math.round(cost.total * 1_000_000_000)
  if (!Number.isSafeInteger(amountNanos)) return {}

  return {
    reportedCost: {
      money: { currency: "USD", amountNanos: amountNanos.toString() },
      providerId: PROVIDER_ID,
    },
  }
}

/**
 * An HTTP failure becomes a provider error with its status; a reply Exa answered but Sixb could
 * not read becomes a response error that keeps what Exa charged. Cancellation passes through.
 */
function providerError(error: unknown, modelId: string): unknown {
  if (!(error instanceof ExaApiError)) return error

  const status = error.status
  if (status !== undefined && status >= 200 && status < 300) {
    return new WebSearchModelResponseError(
      error.message,
      PROVIDER_ID,
      modelId,
      reportedCost(error.costDollars),
      { cause: error }
    )
  }

  return new ModelProviderError(error.message, PROVIDER_ID, modelId, {
    cause: error,
    ...(status === undefined ? {} : { status }),
    ...(error.tag ? { code: error.tag } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    retryable: status === 429 || (status !== undefined && status >= 500),
  })
}
