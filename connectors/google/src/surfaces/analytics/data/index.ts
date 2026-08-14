import type { GoogleHttp } from "../../../http"
import { type AnalyticsDataPropertiesResource, analyticsDataPropertiesResource } from "./properties"

export interface AnalyticsDataSurface {
  readonly properties: AnalyticsDataPropertiesResource
}

export function analyticsDataSurface(http: GoogleHttp): AnalyticsDataSurface {
  return {
    properties: analyticsDataPropertiesResource(http),
  }
}
