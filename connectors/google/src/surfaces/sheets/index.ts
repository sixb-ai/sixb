import type { GoogleHttp } from "../../http"
import { type SheetsSpreadsheetsResource, sheetsSpreadsheetsResource } from "./spreadsheets"

export interface SheetsSurface {
  readonly spreadsheets: SheetsSpreadsheetsResource
}

export function sheetsSurface(http: GoogleHttp): SheetsSurface {
  return {
    spreadsheets: sheetsSpreadsheetsResource(http),
  }
}
