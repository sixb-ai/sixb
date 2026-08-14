import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsAccount,
  AnalyticsAccountListOptions,
  AnalyticsChangeHistoryEvent,
  AnalyticsDataSharingSettings,
  AnalyticsListAccountsResponse,
  AnalyticsProvisionAccountTicketRequest,
  AnalyticsProvisionAccountTicketResponse,
  AnalyticsRunAccessReportRequest,
  AnalyticsRunAccessReportResponse,
  AnalyticsSearchChangeHistoryRequest,
  AnalyticsSearchChangeHistoryResponse,
  AnalyticsUpdateOptions,
} from "../../../types/analytics-admin"
import { accountName } from "../paths"

export interface AnalyticsAccountsResource {
  list(options?: AnalyticsAccountListOptions): Promise<AnalyticsListAccountsResponse>
  listAll(options?: AnalyticsAccountListOptions): AsyncIterable<AnalyticsAccount>
  get(name: string): Promise<AnalyticsAccount>
  /** Soft-delete an account. It can still be restored through the Analytics UI. */
  delete(name: string): Promise<void>
  patch(
    name: string,
    account: Partial<AnalyticsAccount>,
    options: AnalyticsUpdateOptions
  ): Promise<AnalyticsAccount>
  getDataSharingSettings(name: string): Promise<AnalyticsDataSharingSettings>
  provisionAccountTicket(
    request: AnalyticsProvisionAccountTicketRequest
  ): Promise<AnalyticsProvisionAccountTicketResponse>
  runAccessReport(
    name: string,
    request: AnalyticsRunAccessReportRequest
  ): Promise<AnalyticsRunAccessReportResponse>
  searchChangeHistoryEvents(
    name: string,
    request?: AnalyticsSearchChangeHistoryRequest
  ): Promise<AnalyticsSearchChangeHistoryResponse>
  searchChangeHistoryEventsAll(
    name: string,
    request?: AnalyticsSearchChangeHistoryRequest
  ): AsyncIterable<AnalyticsChangeHistoryEvent>
}

export function analyticsAccountsResource(http: GoogleHttp): AnalyticsAccountsResource {
  const resource: AnalyticsAccountsResource = {
    list(options) {
      return http.json("analyticsAdmin", "GET", "accounts", { query: options })
    },
    listAll(options) {
      return listAllPages(
        (pageToken) => resource.list({ ...options, pageToken }),
        (page) => page.accounts,
        options?.pageToken
      )
    },
    get(name) {
      return http.json("analyticsAdmin", "GET", accountName(name, "name"))
    },
    delete(name) {
      return http.json("analyticsAdmin", "DELETE", accountName(name, "name"))
    },
    patch(name, account, options) {
      const path = accountName(name, "name")
      return http.json("analyticsAdmin", "PATCH", path, {
        query: options,
        body: { ...account, name },
      })
    },
    getDataSharingSettings(name) {
      return http.json("analyticsAdmin", "GET", `${accountName(name, "name")}/dataSharingSettings`)
    },
    provisionAccountTicket(request) {
      return http.json("analyticsAdmin", "POST", "accounts:provisionAccountTicket", {
        body: request,
      })
    },
    runAccessReport(name, request) {
      return http.json("analyticsAdmin", "POST", `${accountName(name, "name")}:runAccessReport`, {
        body: request,
        retryable: true,
      })
    },
    searchChangeHistoryEvents(name, request = {}) {
      return http.json(
        "analyticsAdmin",
        "POST",
        `${accountName(name, "name")}:searchChangeHistoryEvents`,
        { body: request, retryable: true }
      )
    },
    searchChangeHistoryEventsAll(name, request = {}) {
      return listAllPages(
        (pageToken) => resource.searchChangeHistoryEvents(name, { ...request, pageToken }),
        (page) => page.changeHistoryEvents,
        request.pageToken
      )
    },
  }
  return resource
}
