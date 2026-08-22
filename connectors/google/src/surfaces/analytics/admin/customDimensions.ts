import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsCustomDimension,
  AnalyticsCustomDimensionListOptions,
  AnalyticsListCustomDimensionsResponse,
  AnalyticsUpdateOptions,
} from "../../../types/analytics-admin"
import { childResourceName, propertyName } from "../paths"

export interface AnalyticsCustomDimensionsResource {
  list(
    parent: string,
    options?: AnalyticsCustomDimensionListOptions
  ): Promise<AnalyticsListCustomDimensionsResponse>
  listAll(
    parent: string,
    options?: AnalyticsCustomDimensionListOptions
  ): AsyncIterable<AnalyticsCustomDimension>
  get(name: string): Promise<AnalyticsCustomDimension>
  create(parent: string, dimension: AnalyticsCustomDimension): Promise<AnalyticsCustomDimension>
  patch(
    name: string,
    dimension: Partial<AnalyticsCustomDimension>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsCustomDimension>
  archive(name: string): Promise<void>
}

export function analyticsCustomDimensionsResource(
  http: GoogleHttp
): AnalyticsCustomDimensionsResource {
  const resource: AnalyticsCustomDimensionsResource = {
    list(parent, options) {
      return http.json(
        "analyticsAdmin",
        "GET",
        `${propertyName(parent, "parent")}/customDimensions`,
        { query: options }
      )
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.customDimensions,
        options?.pageToken
      )
    },
    get(name) {
      return http.json("analyticsAdmin", "GET", childResourceName(name, "customDimensions"))
    },
    create(parent, dimension) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${propertyName(parent, "parent")}/customDimensions`,
        { body: dimension }
      )
    },
    patch(name, dimension, options) {
      const path = childResourceName(name, "customDimensions")
      return http.json("analyticsAdmin", "PATCH", path, {
        query: options,
        body: { ...dimension, name },
      })
    },
    archive(name) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${childResourceName(name, "customDimensions")}:archive`,
        { body: {} }
      )
    },
  }
  return resource
}
