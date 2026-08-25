import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import type {
  SheetsBatchGetValuesResponse,
  SheetsValueRange,
  SheetsValuesBatchGetOptions,
  SheetsValuesGetOptions,
} from "../../types/sheets"

export interface SheetsValuesResource {
  /** `GET /spreadsheets/{spreadsheetId}/values/{range}` — read one A1/R1C1 range. */
  get(
    spreadsheetId: string,
    range: string,
    options?: SheetsValuesGetOptions
  ): Promise<SheetsValueRange>
  /** `GET /spreadsheets/{spreadsheetId}/values:batchGet` — read one or more ranges. */
  batchGet(
    spreadsheetId: string,
    options: SheetsValuesBatchGetOptions
  ): Promise<SheetsBatchGetValuesResponse>
}

export function sheetsValuesResource(http: GoogleHttp): SheetsValuesResource {
  return {
    get(spreadsheetId, range, options) {
      const path = spreadsheetValuesPath(spreadsheetId)
      return http.json("sheets", "GET", `${path}/${pathSegment(range, "range")}`, {
        query: options,
      })
    },
    batchGet(spreadsheetId, options) {
      const path = spreadsheetValuesPath(spreadsheetId)
      assertRanges(options.ranges)
      return http.json("sheets", "GET", `${path}:batchGet`, { query: options })
    },
  }
}

function spreadsheetValuesPath(spreadsheetId: string): string {
  return `spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}/values`
}

function assertRanges(ranges: readonly string[]): void {
  if (ranges.length === 0) {
    throw new Error("[SixbGoogle] options.ranges must contain at least one range.")
  }
  for (const range of ranges) {
    pathSegment(range, "options.ranges item")
  }
}
