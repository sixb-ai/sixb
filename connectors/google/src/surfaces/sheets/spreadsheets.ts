import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import type {
  SheetsPartialResponseOptions,
  SheetsSpreadsheet,
  SheetsSpreadsheetBatchUpdateRequest,
  SheetsSpreadsheetBatchUpdateResponse,
  SheetsSpreadsheetCreateRequest,
  SheetsSpreadsheetGetByDataFilterRequest,
  SheetsSpreadsheetGetOptions,
} from "../../types/sheets"
import {
  type SheetsDeveloperMetadataResource,
  sheetsDeveloperMetadataResource,
} from "./developerMetadata"
import { type SheetsSheetsResource, sheetsSheetsResource } from "./sheets"
import { assertDataFilters, type SheetsValuesResource, sheetsValuesResource } from "./values"

export interface SheetsSpreadsheetsResource {
  readonly values: SheetsValuesResource
  readonly developerMetadata: SheetsDeveloperMetadataResource
  readonly sheets: SheetsSheetsResource
  /** Create a spreadsheet. */
  create(
    request: SheetsSpreadsheetCreateRequest,
    options?: SheetsPartialResponseOptions
  ): Promise<SheetsSpreadsheet>
  /** `GET /spreadsheets/{spreadsheetId}` — spreadsheet and sheet metadata. */
  get(spreadsheetId: string, options?: SheetsSpreadsheetGetOptions): Promise<SheetsSpreadsheet>
  /** Get spreadsheet data selected by data filters. */
  getByDataFilter(
    spreadsheetId: string,
    request: SheetsSpreadsheetGetByDataFilterRequest,
    options?: SheetsPartialResponseOptions
  ): Promise<SheetsSpreadsheet>
  /** Apply structural and formatting operations atomically. */
  batchUpdate(
    spreadsheetId: string,
    request: SheetsSpreadsheetBatchUpdateRequest
  ): Promise<SheetsSpreadsheetBatchUpdateResponse>
}

export function sheetsSpreadsheetsResource(http: GoogleHttp): SheetsSpreadsheetsResource {
  return {
    values: sheetsValuesResource(http),
    developerMetadata: sheetsDeveloperMetadataResource(http),
    sheets: sheetsSheetsResource(http),
    create(request, options) {
      return http.json("sheets", "POST", "spreadsheets", {
        query: options,
        body: request,
        retryable: false,
      })
    },
    get(spreadsheetId, options) {
      return http.json(
        "sheets",
        "GET",
        `spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}`,
        { query: options }
      )
    },
    getByDataFilter(spreadsheetId, request, options) {
      assertDataFilters(request.dataFilters)
      return http.json(
        "sheets",
        "POST",
        `spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}:getByDataFilter`,
        { query: options, body: request, retryable: true }
      )
    },
    batchUpdate(spreadsheetId, request) {
      if (request.requests.length === 0) {
        throw new Error("[SixbGoogle] request.requests must contain at least one operation.")
      }
      return http.json(
        "sheets",
        "POST",
        `spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}:batchUpdate`,
        { body: request, retryable: false }
      )
    },
  }
}
