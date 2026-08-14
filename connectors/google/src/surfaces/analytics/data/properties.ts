import type { GoogleHttp } from "../../../http"
import type {
  AnalyticsBatchRunPivotReportsRequest,
  AnalyticsBatchRunPivotReportsResponse,
  AnalyticsBatchRunReportsRequest,
  AnalyticsBatchRunReportsResponse,
  AnalyticsCheckCompatibilityRequest,
  AnalyticsCheckCompatibilityResponse,
  AnalyticsDataMetadata,
  AnalyticsDataRow,
  AnalyticsRunPivotReportRequest,
  AnalyticsRunPivotReportResponse,
  AnalyticsRunRealtimeReportRequest,
  AnalyticsRunRealtimeReportResponse,
  AnalyticsRunReportRequest,
  AnalyticsRunReportResponse,
} from "../../../types/analytics-data"
import { propertyName } from "../paths"
import {
  type AnalyticsAudienceExportsResource,
  analyticsAudienceExportsResource,
} from "./audienceExports"
import { analyticsOffset, analyticsPageSize, nextAnalyticsOffset } from "./pagination"

export interface AnalyticsDataPropertiesResource {
  readonly audienceExports: AnalyticsAudienceExportsResource
  runReport(
    property: string,
    request: AnalyticsRunReportRequest
  ): Promise<AnalyticsRunReportResponse>
  /** Fetch every report page. `limit` is used as the page size, not a total-row cap. */
  runReportPages(
    property: string,
    request: AnalyticsRunReportRequest
  ): AsyncIterable<AnalyticsRunReportResponse>
  runReportAll(
    property: string,
    request: AnalyticsRunReportRequest
  ): AsyncIterable<AnalyticsDataRow>
  batchRunReports(
    property: string,
    request: AnalyticsBatchRunReportsRequest
  ): Promise<AnalyticsBatchRunReportsResponse>
  runPivotReport(
    property: string,
    request: AnalyticsRunPivotReportRequest
  ): Promise<AnalyticsRunPivotReportResponse>
  batchRunPivotReports(
    property: string,
    request: AnalyticsBatchRunPivotReportsRequest
  ): Promise<AnalyticsBatchRunPivotReportsResponse>
  runRealtimeReport(
    property: string,
    request: AnalyticsRunRealtimeReportRequest
  ): Promise<AnalyticsRunRealtimeReportResponse>
  getMetadata(property: string): Promise<AnalyticsDataMetadata>
  checkCompatibility(
    property: string,
    request: AnalyticsCheckCompatibilityRequest
  ): Promise<AnalyticsCheckCompatibilityResponse>
}

export function analyticsDataPropertiesResource(http: GoogleHttp): AnalyticsDataPropertiesResource {
  const resource: AnalyticsDataPropertiesResource = {
    audienceExports: analyticsAudienceExportsResource(http),
    runReport(property, request) {
      const path = propertyName(property)
      return http.json("analyticsData", "POST", `${path}:runReport`, {
        body: reportRequestBody(path, request),
        retryable: true,
      })
    },
    async *runReportPages(property, request) {
      const limit = analyticsPageSize(request.limit, "request.limit")
      let offset = analyticsOffset(request.offset, "request.offset")

      for (;;) {
        const page = await resource.runReport(property, {
          ...request,
          limit: String(limit),
          offset: String(offset),
        })
        yield page

        const rowCount = page.rows?.length ?? 0
        const next = nextAnalyticsOffset(offset, rowCount, page.rowCount)
        if (next === undefined) {
          break
        }
        offset = next
      }
    },
    async *runReportAll(property, request) {
      for await (const page of resource.runReportPages(property, request)) {
        for (const row of page.rows ?? []) {
          yield row
        }
      }
    },
    batchRunReports(property, request) {
      const path = propertyName(property)
      assertBatchRequests(path, request.requests)
      return http.json("analyticsData", "POST", `${path}:batchRunReports`, {
        body: request,
        retryable: true,
      })
    },
    runPivotReport(property, request) {
      const path = propertyName(property)
      return http.json("analyticsData", "POST", `${path}:runPivotReport`, {
        body: reportRequestBody(path, request),
        retryable: true,
      })
    },
    batchRunPivotReports(property, request) {
      const path = propertyName(property)
      assertBatchRequests(path, request.requests)
      return http.json("analyticsData", "POST", `${path}:batchRunPivotReports`, {
        body: request,
        retryable: true,
      })
    },
    runRealtimeReport(property, request) {
      const path = propertyName(property)
      return http.json("analyticsData", "POST", `${path}:runRealtimeReport`, {
        body: request,
        retryable: true,
      })
    },
    getMetadata(property) {
      return http.json("analyticsData", "GET", `${propertyName(property)}/metadata`)
    },
    checkCompatibility(property, request) {
      const path = propertyName(property)
      return http.json("analyticsData", "POST", `${path}:checkCompatibility`, {
        body: request,
        retryable: true,
      })
    },
  }
  return resource
}

function reportRequestBody<T extends { readonly property?: string }>(
  property: string,
  request: T
): Omit<T, "property"> {
  if (
    request.property !== undefined &&
    propertyName(request.property, "request.property") !== property
  ) {
    throw new Error(`[SixbGoogle] request.property must match "${property}".`)
  }
  const { property: _property, ...body } = request
  return body
}

function assertBatchRequests(
  property: string,
  requests: readonly { readonly property?: string }[]
): void {
  if (requests.length > 5) {
    throw new Error("[SixbGoogle] Analytics batch requests accept at most 5 reports.")
  }
  for (const request of requests) {
    if (
      request.property !== undefined &&
      propertyName(request.property, "request.property") !== property
    ) {
      throw new Error(`[SixbGoogle] Every batch request.property must match "${property}".`)
    }
  }
}
