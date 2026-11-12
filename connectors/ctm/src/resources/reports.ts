import type { CtmHttp } from "../http"
import type { CtmObject, CtmReportSeriesOptions, CtmUsageLogOptions } from "../types"
import { assertDate, assertNonEmpty, assertPositiveInteger } from "../validation"
import type { CtmAccountPath } from "./shared"

/** Aggregates over the call log, and billed usage. Bodies arrive as CTM returns them. */
export interface ReportsResource {
  /** `GET /reports/series` — activity counts over time, grouped by one dimension. */
  series(options: CtmReportSeriesOptions): Promise<CtmObject>
  /** `GET /reports/usage_logs` — billed minutes and messages by tracking number or account. */
  usageLogs(options: CtmUsageLogOptions): Promise<CtmObject>
}

export function reportsResource(http: CtmHttp, at: CtmAccountPath): ReportsResource {
  return {
    async series(options) {
      assertDate(options.startDate, "startDate")
      assertDate(options.endDate, "endDate")
      assertNonEmpty(options.by, "by")

      return http.get<CtmObject>(at("reports/series.json"), {
        ...options.filters,
        start_date: options.startDate,
        end_date: options.endDate,
        // CTM's docs require it on every series request.
        with_time: 1,
        by: options.by,
        direction: options.direction,
      })
    },

    async usageLogs(options) {
      assertDate(options.startDate, "startDate")
      assertDate(options.endDate, "endDate")
      assertPositiveInteger(options.page, "page")
      assertPositiveInteger(options.pageSize, "pageSize")

      return http.get<CtmObject>(at("reports/usage_logs.json"), {
        start_date: options.startDate,
        end_date: options.endDate,
        group: options.group,
        filter: options.filter,
        page: options.page,
        per_page: options.pageSize,
        // CTM requires `account=1` from an account-level key. `agencyWide` leaves it off, so an
        // agency key reads its other accounts too.
        account: options.agencyWide ? undefined : 1,
      })
    },
  }
}
