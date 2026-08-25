/**
 * Hand-written types for the read-only Google Sheets API v4 surface. The
 * metadata resources stay open-ended because `spreadsheets.get` supports
 * partial responses and the upstream schema evolves independently.
 */
import type { QueryParams } from "./common"

export type SheetsDimension = "DIMENSION_UNSPECIFIED" | "ROWS" | "COLUMNS"

export type SheetsValueRenderOption = "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA"

export type SheetsDateTimeRenderOption = "SERIAL_NUMBER" | "FORMATTED_STRING"

/** Scalar values returned by `spreadsheets.values` read methods. */
export type SheetsCellValue = string | number | boolean

export interface SheetsGridProperties {
  readonly rowCount?: number
  readonly columnCount?: number
  readonly frozenRowCount?: number
  readonly frozenColumnCount?: number
  readonly hideGridlines?: boolean
  readonly rowGroupControlAfter?: boolean
  readonly columnGroupControlAfter?: boolean
  readonly [key: string]: unknown
}

export interface SheetsSheetProperties {
  readonly sheetId?: number
  readonly title?: string
  readonly index?: number
  readonly sheetType?: string
  readonly gridProperties?: SheetsGridProperties
  readonly hidden?: boolean
  readonly rightToLeft?: boolean
  readonly [key: string]: unknown
}

export interface SheetsSheet {
  readonly properties?: SheetsSheetProperties
  readonly [key: string]: unknown
}

export interface SheetsSpreadsheetProperties {
  readonly title?: string
  readonly locale?: string
  readonly autoRecalc?: string
  readonly timeZone?: string
  readonly [key: string]: unknown
}

export interface SheetsSpreadsheet {
  readonly spreadsheetId: string
  readonly properties?: SheetsSpreadsheetProperties
  readonly sheets?: readonly SheetsSheet[]
  readonly spreadsheetUrl?: string
  readonly [key: string]: unknown
}

export type SheetsSpreadsheetGetOptions = QueryParams & {
  /** A1 or R1C1 ranges to include; encoded as repeated `ranges` parameters. */
  readonly ranges?: readonly string[]
  /** Include cell grid data. Prefer `values.get` for ordinary value reads. */
  readonly includeGridData?: boolean
  readonly excludeTablesInBandedRanges?: boolean
  /** Standard Google partial-response selector. */
  readonly fields?: string
}

export interface SheetsValueRange {
  readonly range?: string
  readonly majorDimension?: SheetsDimension
  /** Google omits empty trailing rows and columns, so this may not be rectangular. */
  readonly values?: readonly (readonly SheetsCellValue[])[]
}

export type SheetsValuesGetOptions = QueryParams & {
  readonly majorDimension?: SheetsDimension
  readonly valueRenderOption?: SheetsValueRenderOption
  readonly dateTimeRenderOption?: SheetsDateTimeRenderOption
  readonly fields?: string
}

export type SheetsValuesBatchGetOptions = SheetsValuesGetOptions & {
  /** One or more A1 or R1C1 ranges, returned in the same order. */
  readonly ranges: readonly string[]
}

export interface SheetsBatchGetValuesResponse {
  readonly spreadsheetId: string
  readonly valueRanges?: readonly SheetsValueRange[]
}
