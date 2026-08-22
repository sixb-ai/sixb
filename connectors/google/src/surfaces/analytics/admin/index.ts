import type { GoogleHttp } from "../../../http"
import {
  type AnalyticsAccountSummariesResource,
  analyticsAccountSummariesResource,
} from "./accountSummaries"
import { type AnalyticsAccountsResource, analyticsAccountsResource } from "./accounts"
import {
  type AnalyticsAdminPropertiesResource,
  analyticsAdminPropertiesResource,
} from "./properties"

export interface AnalyticsAdminSurface {
  readonly accountSummaries: AnalyticsAccountSummariesResource
  readonly accounts: AnalyticsAccountsResource
  readonly properties: AnalyticsAdminPropertiesResource
}

export function analyticsAdminSurface(http: GoogleHttp): AnalyticsAdminSurface {
  return {
    accountSummaries: analyticsAccountSummariesResource(http),
    accounts: analyticsAccountsResource(http),
    properties: analyticsAdminPropertiesResource(http),
  }
}
