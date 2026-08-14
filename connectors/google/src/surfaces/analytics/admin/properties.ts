import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsAcknowledgeUserDataCollectionRequest,
  AnalyticsDataRetentionSettings,
  AnalyticsListPropertiesResponse,
  AnalyticsProperty,
  AnalyticsPropertyListOptions,
  AnalyticsRunAccessReportRequest,
  AnalyticsRunAccessReportResponse,
  AnalyticsUpdateOptions,
} from "../../../types/analytics-admin"
import { propertyName } from "../paths"
import {
  type AnalyticsCustomDimensionsResource,
  analyticsCustomDimensionsResource,
} from "./customDimensions"
import {
  type AnalyticsCustomMetricsResource,
  analyticsCustomMetricsResource,
} from "./customMetrics"
import { type AnalyticsDataStreamsResource, analyticsDataStreamsResource } from "./dataStreams"
import {
  type AnalyticsFirebaseLinksResource,
  analyticsFirebaseLinksResource,
} from "./firebaseLinks"
import {
  type AnalyticsGoogleAdsLinksResource,
  analyticsGoogleAdsLinksResource,
} from "./googleAdsLinks"
import { type AnalyticsKeyEventsResource, analyticsKeyEventsResource } from "./keyEvents"

export interface AnalyticsAdminPropertiesResource {
  readonly customDimensions: AnalyticsCustomDimensionsResource
  readonly customMetrics: AnalyticsCustomMetricsResource
  readonly dataStreams: AnalyticsDataStreamsResource
  readonly firebaseLinks: AnalyticsFirebaseLinksResource
  readonly googleAdsLinks: AnalyticsGoogleAdsLinksResource
  readonly keyEvents: AnalyticsKeyEventsResource
  list(options: AnalyticsPropertyListOptions): Promise<AnalyticsListPropertiesResponse>
  listAll(options: AnalyticsPropertyListOptions): AsyncIterable<AnalyticsProperty>
  get(name: string): Promise<AnalyticsProperty>
  create(property: AnalyticsProperty): Promise<AnalyticsProperty>
  patch(
    name: string,
    property: Partial<AnalyticsProperty>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsProperty>
  /** Soft-delete a property and return its trashed representation. */
  delete(name: string): Promise<AnalyticsProperty>
  acknowledgeUserDataCollection(
    name: string,
    request: AnalyticsAcknowledgeUserDataCollectionRequest
  ): Promise<void>
  getDataRetentionSettings(name: string): Promise<AnalyticsDataRetentionSettings>
  updateDataRetentionSettings(
    name: string,
    settings: Partial<AnalyticsDataRetentionSettings>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsDataRetentionSettings>
  runAccessReport(
    name: string,
    request: AnalyticsRunAccessReportRequest
  ): Promise<AnalyticsRunAccessReportResponse>
}

export function analyticsAdminPropertiesResource(
  http: GoogleHttp
): AnalyticsAdminPropertiesResource {
  const resource: AnalyticsAdminPropertiesResource = {
    customDimensions: analyticsCustomDimensionsResource(http),
    customMetrics: analyticsCustomMetricsResource(http),
    dataStreams: analyticsDataStreamsResource(http),
    firebaseLinks: analyticsFirebaseLinksResource(http),
    googleAdsLinks: analyticsGoogleAdsLinksResource(http),
    keyEvents: analyticsKeyEventsResource(http),
    list(options) {
      return http.json("analyticsAdmin", "GET", "properties", { query: options })
    },
    listAll(options) {
      return listAllPages(
        (pageToken) => resource.list({ ...options, pageToken }),
        (page) => page.properties,
        options.pageToken
      )
    },
    get(name) {
      return http.json("analyticsAdmin", "GET", propertyName(name, "name"))
    },
    create(property) {
      return http.json("analyticsAdmin", "POST", "properties", { body: property })
    },
    patch(name, property, options) {
      const path = propertyName(name, "name")
      return http.json("analyticsAdmin", "PATCH", path, {
        query: options,
        body: { ...property, name },
      })
    },
    delete(name) {
      return http.json("analyticsAdmin", "DELETE", propertyName(name, "name"))
    },
    acknowledgeUserDataCollection(name, request) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${propertyName(name, "property")}:acknowledgeUserDataCollection`,
        { body: request }
      )
    },
    getDataRetentionSettings(name) {
      return http.json(
        "analyticsAdmin",
        "GET",
        `${propertyName(name, "name")}/dataRetentionSettings`
      )
    },
    updateDataRetentionSettings(name, settings, options) {
      const settingsName = `${name}/dataRetentionSettings`
      return http.json(
        "analyticsAdmin",
        "PATCH",
        `${propertyName(name, "name")}/dataRetentionSettings`,
        { query: options, body: { ...settings, name: settingsName } }
      )
    },
    runAccessReport(name, request) {
      return http.json("analyticsAdmin", "POST", `${propertyName(name, "name")}:runAccessReport`, {
        body: request,
        retryable: true,
      })
    },
  }
  return resource
}
