import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import type { SheetsSpreadsheet, SheetsSpreadsheetGetOptions } from "../../types/sheets"
import { type SheetsValuesResource, sheetsValuesResource } from "./values"

export interface SheetsSpreadsheetsResource {
  readonly values: SheetsValuesResource
  /** `GET /spreadsheets/{spreadsheetId}` — spreadsheet and sheet metadata. */
  get(spreadsheetId: string, options?: SheetsSpreadsheetGetOptions): Promise<SheetsSpreadsheet>
}

export function sheetsSpreadsheetsResource(http: GoogleHttp): SheetsSpreadsheetsResource {
  return {
    values: sheetsValuesResource(http),
    get(spreadsheetId, options) {
      return http.json(
        "sheets",
        "GET",
        `spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}`,
        { query: options }
      )
    },
  }
}
