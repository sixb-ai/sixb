import { isRecord } from "../../guards"
import { GoogleAdsConfigurationError, GoogleAdsProtocolError } from "../errors"
import type { GoogleAdsHttp } from "../http"
import { MANAGED_CUSTOMERS_QUERY } from "../queries"
import type { GoogleAdsManagedCustomer, GoogleAdsRow } from "../types"
import type { GoogleAdsReportsResource } from "./reports"

interface AccessibleCustomersResponse {
  readonly resourceNames?: readonly string[]
}

export interface GoogleAdsCustomersResource {
  /** Direct OAuth/service-account grants only; this is not the MCC descendant list. */
  listAccessible(): Promise<readonly string[]>
  /** Enabled leaf advertiser accounts below the configured `login-customer-id`. */
  listManaged(): AsyncIterable<GoogleAdsManagedCustomer>
}

export function createGoogleAdsCustomersResource(
  http: GoogleAdsHttp,
  managerReports: GoogleAdsReportsResource
): GoogleAdsCustomersResource {
  return {
    async listAccessible() {
      const response = await http.get<unknown>(
        // `./` prevents URL from interpreting the colon as a custom scheme.
        "./customers:listAccessibleCustomers"
      )
      assertAccessibleCustomersResponse(response)
      return response.resourceNames ?? []
    },
    listManaged() {
      return listManagedCustomers(managerReports)
    },
  }
}

function assertAccessibleCustomersResponse(
  value: unknown
): asserts value is AccessibleCustomersResponse {
  if (!isRecord(value)) {
    throw new GoogleAdsProtocolError(
      "ListAccessibleCustomers returned an unexpected response shape (expected an object).",
      value
    )
  }
  const resourceNames = value.resourceNames
  if (
    resourceNames !== undefined &&
    (!Array.isArray(resourceNames) || resourceNames.some((name) => typeof name !== "string"))
  ) {
    throw new GoogleAdsProtocolError(
      "ListAccessibleCustomers returned an invalid resourceNames field.",
      value
    )
  }
}

async function* listManagedCustomers(
  reports: GoogleAdsReportsResource
): AsyncIterable<GoogleAdsManagedCustomer> {
  for await (const row of reports.searchAll<GoogleAdsRow>({ query: MANAGED_CUSTOMERS_QUERY })) {
    const customer = row.customerClient
    if (!customer?.id) {
      throw new GoogleAdsConfigurationError(
        "customer_client query returned a row without customerClient.id."
      )
    }
    // The fixed query guarantees these predicates; keep the useful refinements in the public type.
    yield { ...customer, id: customer.id, manager: false, status: "ENABLED" }
  }
}
