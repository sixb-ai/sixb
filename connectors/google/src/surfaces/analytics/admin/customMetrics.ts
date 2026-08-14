import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsCustomMetric,
  AnalyticsCustomMetricListOptions,
  AnalyticsListCustomMetricsResponse,
  AnalyticsUpdateOptions,
} from "../../../types/analytics-admin"
import { childResourceName, propertyName } from "../paths"

export interface AnalyticsCustomMetricsResource {
  list(
    parent: string,
    options?: AnalyticsCustomMetricListOptions
  ): Promise<AnalyticsListCustomMetricsResponse>
  listAll(
    parent: string,
    options?: AnalyticsCustomMetricListOptions
  ): AsyncIterable<AnalyticsCustomMetric>
  get(name: string): Promise<AnalyticsCustomMetric>
  create(parent: string, metric: AnalyticsCustomMetric): Promise<AnalyticsCustomMetric>
  patch(
    name: string,
    metric: Partial<AnalyticsCustomMetric>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsCustomMetric>
  archive(name: string): Promise<void>
}

export function analyticsCustomMetricsResource(http: GoogleHttp): AnalyticsCustomMetricsResource {
  const resource: AnalyticsCustomMetricsResource = {
    list(parent, options) {
      return http.json("analyticsAdmin", "GET", `${propertyName(parent, "parent")}/customMetrics`, {
        query: options,
      })
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.customMetrics,
        options?.pageToken
      )
    },
    get(name) {
      return http.json("analyticsAdmin", "GET", childResourceName(name, "customMetrics"))
    },
    create(parent, metric) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${propertyName(parent, "parent")}/customMetrics`,
        { body: metric }
      )
    },
    patch(name, metric, options) {
      const path = childResourceName(name, "customMetrics")
      return http.json("analyticsAdmin", "PATCH", path, {
        query: options,
        body: { ...metric, name },
      })
    },
    archive(name) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${childResourceName(name, "customMetrics")}:archive`,
        { body: {} }
      )
    },
  }
  return resource
}
