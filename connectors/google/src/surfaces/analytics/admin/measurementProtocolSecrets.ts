import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsListMeasurementProtocolSecretsResponse,
  AnalyticsMeasurementProtocolSecret,
  AnalyticsMeasurementProtocolSecretListOptions,
  AnalyticsUpdateOptions,
} from "../../../types/analytics-admin"
import { dataStreamName, measurementProtocolSecretName } from "../paths"

export interface AnalyticsMeasurementProtocolSecretsResource {
  list(
    parent: string,
    options?: AnalyticsMeasurementProtocolSecretListOptions
  ): Promise<AnalyticsListMeasurementProtocolSecretsResponse>
  listAll(
    parent: string,
    options?: AnalyticsMeasurementProtocolSecretListOptions
  ): AsyncIterable<AnalyticsMeasurementProtocolSecret>
  get(name: string): Promise<AnalyticsMeasurementProtocolSecret>
  create(
    parent: string,
    secret: AnalyticsMeasurementProtocolSecret
  ): Promise<AnalyticsMeasurementProtocolSecret>
  patch(
    name: string,
    secret: Partial<AnalyticsMeasurementProtocolSecret>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsMeasurementProtocolSecret>
  delete(name: string): Promise<void>
}

export function analyticsMeasurementProtocolSecretsResource(
  http: GoogleHttp
): AnalyticsMeasurementProtocolSecretsResource {
  const resource: AnalyticsMeasurementProtocolSecretsResource = {
    list(parent, options) {
      return http.json(
        "analyticsAdmin",
        "GET",
        `${dataStreamName(parent, "parent")}/measurementProtocolSecrets`,
        { query: options }
      )
    },
    listAll(parent, options) {
      return listAllPages(
        (pageToken) => resource.list(parent, { ...options, pageToken }),
        (page) => page.measurementProtocolSecrets,
        options?.pageToken
      )
    },
    get(name) {
      return http.json("analyticsAdmin", "GET", measurementProtocolSecretName(name))
    },
    create(parent, secret) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${dataStreamName(parent, "parent")}/measurementProtocolSecrets`,
        { body: secret }
      )
    },
    patch(name, secret, options) {
      const path = measurementProtocolSecretName(name)
      return http.json("analyticsAdmin", "PATCH", path, {
        query: options,
        body: { ...secret, name },
      })
    },
    delete(name) {
      return http.json("analyticsAdmin", "DELETE", measurementProtocolSecretName(name))
    },
  }
  return resource
}
