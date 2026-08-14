import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsDataStream,
  AnalyticsDataStreamListOptions,
  AnalyticsListDataStreamsResponse,
  AnalyticsUpdateOptions,
} from "../../../types/analytics-admin"
import { dataStreamName, propertyName } from "../paths"
import {
  type AnalyticsMeasurementProtocolSecretsResource,
  analyticsMeasurementProtocolSecretsResource,
} from "./measurementProtocolSecrets"

export interface AnalyticsDataStreamsResource {
  readonly measurementProtocolSecrets: AnalyticsMeasurementProtocolSecretsResource
  list(
    parent: string,
    options?: AnalyticsDataStreamListOptions
  ): Promise<AnalyticsListDataStreamsResponse>
  listAll(
    parent: string,
    options?: AnalyticsDataStreamListOptions
  ): AsyncIterable<AnalyticsDataStream>
  get(name: string): Promise<AnalyticsDataStream>
  create(parent: string, stream: AnalyticsDataStream): Promise<AnalyticsDataStream>
  patch(
    name: string,
    stream: Partial<AnalyticsDataStream>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsDataStream>
  delete(name: string): Promise<void>
}

export function analyticsDataStreamsResource(http: GoogleHttp): AnalyticsDataStreamsResource {
  const resource: AnalyticsDataStreamsResource = {
    measurementProtocolSecrets: analyticsMeasurementProtocolSecretsResource(http),
    list(parent, options) {
      return http.json("analyticsAdmin", "GET", `${propertyName(parent, "parent")}/dataStreams`, {
        query: options,
      })
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.dataStreams,
        options?.pageToken
      )
    },
    get(name) {
      return http.json("analyticsAdmin", "GET", dataStreamName(name, "name"))
    },
    create(parent, stream) {
      return http.json("analyticsAdmin", "POST", `${propertyName(parent, "parent")}/dataStreams`, {
        body: stream,
      })
    },
    patch(name, stream, options) {
      const path = dataStreamName(name, "name")
      return http.json("analyticsAdmin", "PATCH", path, {
        query: options,
        body: { ...stream, name },
      })
    },
    delete(name) {
      return http.json("analyticsAdmin", "DELETE", dataStreamName(name, "name"))
    },
  }
  return resource
}
