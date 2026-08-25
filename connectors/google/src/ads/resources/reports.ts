import { isRecord } from "../../guards"
import { GoogleAdsConfigurationError, GoogleAdsProtocolError } from "../errors"
import type { GoogleAdsHttp } from "../http"
import { customerDailyPerformanceQuery } from "../queries"
import type {
  GoogleAdsCustomerDailyPerformanceOptions,
  GoogleAdsCustomerDailyPerformanceRow,
  GoogleAdsRow,
  GoogleAdsSearchRequest,
  GoogleAdsSearchResponse,
  GoogleAdsSearchStreamRequest,
  GoogleAdsSearchStreamResponse,
} from "../types"
import { assertGaql, assertOptionalPageToken } from "../validation"

export interface GoogleAdsReportsResource {
  /** One fixed-size page (10,000 rows) from `GoogleAdsService.Search`. */
  search<TRow = GoogleAdsRow>(
    request: GoogleAdsSearchRequest
  ): Promise<GoogleAdsSearchResponse<TRow>>
  /** Every row, following `nextPageToken` while keeping the GAQL query identical. */
  searchAll<TRow = GoogleAdsRow>(request: GoogleAdsSearchRequest): AsyncIterable<TRow>
  /** Raw REST SearchStream batches. The REST JSON array is buffered before this resolves. */
  searchStream<TRow = GoogleAdsRow>(
    request: GoogleAdsSearchStreamRequest
  ): Promise<readonly GoogleAdsSearchStreamResponse<TRow>[]>
  /** Built-in `(customer, date)` report over additive performance metrics. */
  customerDaily(
    options: GoogleAdsCustomerDailyPerformanceOptions
  ): AsyncIterable<GoogleAdsCustomerDailyPerformanceRow>
}

export function createGoogleAdsReportsResource(
  http: GoogleAdsHttp,
  customerId: string
): GoogleAdsReportsResource {
  const searchPath = `customers/${customerId}/googleAds:search`
  const streamPath = `customers/${customerId}/googleAds:searchStream`

  const resource: GoogleAdsReportsResource = {
    async search<TRow = GoogleAdsRow>(
      request: GoogleAdsSearchRequest
    ): Promise<GoogleAdsSearchResponse<TRow>> {
      validateSearchRequest(request)
      const response = await http.post<unknown>(searchPath, request)
      assertSearchResponse(response)
      return response as GoogleAdsSearchResponse<TRow>
    },
    searchAll(request) {
      validateSearchRequest(request)
      return searchAllRows(resource, request)
    },
    async searchStream<TRow = GoogleAdsRow>(
      request: GoogleAdsSearchStreamRequest
    ): Promise<readonly GoogleAdsSearchStreamResponse<TRow>[]> {
      assertGaql(request.query)
      const batches = await http.post<unknown>(streamPath, request)
      assertSearchStreamResponse(batches)
      return batches as readonly GoogleAdsSearchStreamResponse<TRow>[]
    },
    customerDaily(options) {
      return resource.searchAll<GoogleAdsCustomerDailyPerformanceRow>({
        query: customerDailyPerformanceQuery(options),
      })
    },
  }

  return resource
}

async function* searchAllRows<TRow>(
  resource: GoogleAdsReportsResource,
  request: GoogleAdsSearchRequest
): AsyncIterable<TRow> {
  let pageToken = request.pageToken
  const seen = new Set<string>()
  if (pageToken) {
    seen.add(pageToken)
  }

  for (;;) {
    const page = await resource.search<TRow>({ ...request, pageToken })
    for (const row of page.results ?? []) {
      yield row
    }

    const next = page.nextPageToken
    if (!next) {
      return
    }
    if (seen.has(next)) {
      throw new GoogleAdsConfigurationError(
        `Search pagination repeated page token "${next}"; refusing to loop forever.`
      )
    }
    seen.add(next)
    pageToken = next
  }
}

function validateSearchRequest(request: GoogleAdsSearchRequest): void {
  assertGaql(request.query)
  assertOptionalPageToken(request.pageToken)
  if ("pageSize" in request) {
    throw new GoogleAdsConfigurationError(
      "pageSize is not supported by Google Ads Search; pages are fixed at 10,000 rows."
    )
  }
}

function assertSearchResponse(value: unknown): asserts value is GoogleAdsSearchResponse<unknown> {
  if (!isRecord(value)) {
    throw protocolError("Search returned an unexpected response shape (expected an object).", value)
  }
  if (value.results !== undefined && !Array.isArray(value.results)) {
    throw protocolError("Search returned a non-array results field.", value)
  }
  if (value.nextPageToken !== undefined && typeof value.nextPageToken !== "string") {
    throw protocolError("Search returned a non-string nextPageToken field.", value)
  }
}

function assertSearchStreamResponse(
  value: unknown
): asserts value is readonly GoogleAdsSearchStreamResponse<unknown>[] {
  if (!Array.isArray(value) || value.some((batch) => !isRecord(batch))) {
    throw protocolError(
      "SearchStream returned an unexpected response shape (expected an array of objects).",
      value
    )
  }
  if (value.some((batch) => batch.results !== undefined && !Array.isArray(batch.results))) {
    throw protocolError("SearchStream returned a non-array results field.", value)
  }
}

function protocolError(message: string, body: unknown): GoogleAdsProtocolError {
  return new GoogleAdsProtocolError(message, body)
}
