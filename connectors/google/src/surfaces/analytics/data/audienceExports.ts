import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsAudienceExport,
  AnalyticsAudienceRow,
  AnalyticsListAudienceExportsOptions,
  AnalyticsListAudienceExportsResponse,
  AnalyticsOperation,
  AnalyticsQueryAudienceExportRequest,
  AnalyticsQueryAudienceExportResponse,
} from "../../../types/analytics-data"
import { childResourceName, propertyName } from "../paths"
import { analyticsOffset, analyticsPageSize, nextAnalyticsOffset } from "./pagination"

export interface AnalyticsAudienceExportsResource {
  create(parent: string, audienceExport: AnalyticsAudienceExport): Promise<AnalyticsOperation>
  get(name: string): Promise<AnalyticsAudienceExport>
  list(
    parent: string,
    options?: AnalyticsListAudienceExportsOptions
  ): Promise<AnalyticsListAudienceExportsResponse>
  listAll(
    parent: string,
    options?: AnalyticsListAudienceExportsOptions
  ): AsyncIterable<AnalyticsAudienceExport>
  query(
    name: string,
    request?: AnalyticsQueryAudienceExportRequest
  ): Promise<AnalyticsQueryAudienceExportResponse>
  /** Fetch every query page. `limit` is used as the page size, not a total-row cap. */
  queryPages(
    name: string,
    request?: AnalyticsQueryAudienceExportRequest
  ): AsyncIterable<AnalyticsQueryAudienceExportResponse>
  queryAll(
    name: string,
    request?: AnalyticsQueryAudienceExportRequest
  ): AsyncIterable<AnalyticsAudienceRow>
}

export function analyticsAudienceExportsResource(
  http: GoogleHttp
): AnalyticsAudienceExportsResource {
  const resource: AnalyticsAudienceExportsResource = {
    create(parent, audienceExport) {
      return http.json(
        "analyticsData",
        "POST",
        `${propertyName(parent, "parent")}/audienceExports`,
        {
          body: audienceExport,
        }
      )
    },
    get(name) {
      return http.json("analyticsData", "GET", childResourceName(name, "audienceExports", "name"))
    },
    list(parent, options) {
      return http.json(
        "analyticsData",
        "GET",
        `${propertyName(parent, "parent")}/audienceExports`,
        {
          query: options,
        }
      )
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.audienceExports,
        options?.pageToken
      )
    },
    query(name, request = {}) {
      return http.json(
        "analyticsData",
        "POST",
        `${childResourceName(name, "audienceExports", "name")}:query`,
        { body: request, retryable: true }
      )
    },
    async *queryPages(name, request = {}) {
      const limit = analyticsPageSize(request.limit, "request.limit")
      let offset = analyticsOffset(request.offset, "request.offset")

      for (;;) {
        const page = await resource.query(name, {
          ...request,
          limit: String(limit),
          offset: String(offset),
        })
        yield page

        const rowCount = page.audienceRows?.length ?? 0
        const next = nextAnalyticsOffset(offset, rowCount, page.rowCount)
        if (next === undefined) {
          break
        }
        offset = next
      }
    },
    async *queryAll(name, request = {}) {
      for await (const page of resource.queryPages(name, request)) {
        for (const row of page.audienceRows ?? []) {
          yield row
        }
      }
    },
  }
  return resource
}
