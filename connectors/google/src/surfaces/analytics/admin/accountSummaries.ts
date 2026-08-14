import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type {
  AnalyticsAccountSummary,
  AnalyticsListAccountSummariesResponse,
  AnalyticsPageOptions,
} from "../../../types/analytics-admin"

export interface AnalyticsAccountSummariesResource {
  /** `GET /v1beta/accountSummaries` — accounts and their visible properties. */
  list(options?: AnalyticsPageOptions): Promise<AnalyticsListAccountSummariesResponse>
  /** Iterate all account summaries across every page. */
  listAll(options?: AnalyticsPageOptions): AsyncIterable<AnalyticsAccountSummary>
}

export function analyticsAccountSummariesResource(
  http: GoogleHttp
): AnalyticsAccountSummariesResource {
  const resource: AnalyticsAccountSummariesResource = {
    list(options) {
      return http.json("analyticsAdmin", "GET", "accountSummaries", { query: options })
    },
    listAll(options) {
      return listAllPages(
        (pageToken) => resource.list({ ...options, pageToken }),
        (page) => page.accountSummaries,
        options?.pageToken
      )
    },
  }
  return resource
}
