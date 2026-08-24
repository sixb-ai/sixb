import type { GoogleAdsHttp } from "./http"
import {
  createGoogleAdsCustomersResource,
  type GoogleAdsCustomersResource,
} from "./resources/customers"
import { createGoogleAdsReportsResource, type GoogleAdsReportsResource } from "./resources/reports"
import { normalizeCustomerId } from "./validation"

export interface GoogleAdsCustomerScope {
  readonly id: string
  readonly reports: GoogleAdsReportsResource
}

export interface GoogleAdsClient {
  readonly loginCustomerId: string
  readonly customers: GoogleAdsCustomersResource
  /** Scope reporting calls to one operating advertiser account. */
  customer(customerId: string): GoogleAdsCustomerScope
}

export function createGoogleAdsClient(
  http: GoogleAdsHttp,
  loginCustomerId: string
): GoogleAdsClient {
  const managerReports = createGoogleAdsReportsResource(http, loginCustomerId)
  return {
    loginCustomerId,
    customers: createGoogleAdsCustomersResource(http, managerReports),
    customer(customerId) {
      const id = normalizeCustomerId(customerId, "customerId")
      return { id, reports: createGoogleAdsReportsResource(http, id) }
    },
  }
}
