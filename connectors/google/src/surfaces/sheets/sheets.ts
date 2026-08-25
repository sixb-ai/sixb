import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import type { SheetsCopySheetRequest, SheetsSheetProperties } from "../../types/sheets"

export interface SheetsSheetsResource {
  /** Copy one sheet into another spreadsheet. */
  copyTo(
    spreadsheetId: string,
    sheetId: number,
    request: SheetsCopySheetRequest
  ): Promise<SheetsSheetProperties>
}

export function sheetsSheetsResource(http: GoogleHttp): SheetsSheetsResource {
  return {
    copyTo(spreadsheetId, sheetId, request) {
      pathSegment(request.destinationSpreadsheetId, "request.destinationSpreadsheetId")
      const path = `spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}/sheets/${integerId(
        sheetId,
        "sheetId"
      )}:copyTo`
      return http.json("sheets", "POST", path, {
        body: request,
        retryable: false,
      })
    },
  }
}

function integerId(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`[SixbGoogle] ${name} must be a non-negative safe integer.`)
  }
  return String(value)
}
