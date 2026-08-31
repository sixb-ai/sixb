/**
 * Hand-written wire types for Google Sheets API v4. Large metadata objects and
 * batch-update payloads stay open-ended where Google evolves the schema
 * independently, while resource methods and operation names remain typed.
 */
import type { QueryParams } from "./common"

export type SheetsDimension = "DIMENSION_UNSPECIFIED" | "ROWS" | "COLUMNS"
export type SheetsValueRenderOption = "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA"
export type SheetsDateTimeRenderOption = "SERIAL_NUMBER" | "FORMATTED_STRING"
export type SheetsValueInputOption = "INPUT_VALUE_OPTION_UNSPECIFIED" | "RAW" | "USER_ENTERED"
export type SheetsInsertDataOption = "OVERWRITE" | "INSERT_ROWS"
export type SheetsDeveloperMetadataVisibility =
  | "DEVELOPER_METADATA_VISIBILITY_UNSPECIFIED"
  | "DOCUMENT"
  | "PROJECT"
export type SheetsDeveloperMetadataLocationType =
  | "DEVELOPER_METADATA_LOCATION_TYPE_UNSPECIFIED"
  | "ROW"
  | "COLUMN"
  | "SHEET"
  | "SPREADSHEET"
export type SheetsDeveloperMetadataLocationMatchingStrategy =
  | "DEVELOPER_METADATA_LOCATION_MATCHING_STRATEGY_UNSPECIFIED"
  | "EXACT_LOCATION"
  | "INTERSECTING_LOCATION"
export type SheetsCommentsViewMode =
  | "COMMENTS_VIEW_MODE_UNSPECIFIED"
  | "COMMENTS_VIEW_MODE_DEFAULT_FOR_CURRENT_ACCESS"
  | "COMMENTS_VIEW_MODE_OMITTED"
  | "COMMENTS_VIEW_MODE_INCLUDED"

/** Scalar values returned by `spreadsheets.values` read methods. */
export type SheetsCellValue = string | number | boolean
/** `null` is accepted on writes and leaves the corresponding cell unchanged. */
export type SheetsInputCellValue = SheetsCellValue | null

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

export interface SheetsSpreadsheetCreateRequest {
  readonly properties?: SheetsSpreadsheetProperties
  readonly sheets?: readonly SheetsSheet[]
  readonly namedRanges?: readonly Readonly<Record<string, unknown>>[]
  readonly [key: string]: unknown
}

export type SheetsSpreadsheetGetOptions = QueryParams & {
  /** A1 or R1C1 ranges to include; encoded as repeated `ranges` parameters. */
  readonly ranges?: readonly string[]
  /** Include cell grid data. Prefer `values.get` for ordinary value reads. */
  readonly includeGridData?: boolean
  readonly excludeTablesInBandedRanges?: boolean
  readonly commentsViewMode?: SheetsCommentsViewMode
  /** Standard Google partial-response selector. */
  readonly fields?: string
}

export interface SheetsGridRange {
  readonly sheetId?: number
  readonly startRowIndex?: number
  readonly endRowIndex?: number
  readonly startColumnIndex?: number
  readonly endColumnIndex?: number
}

export interface SheetsDimensionRange {
  readonly sheetId: number
  readonly dimension: SheetsDimension
  readonly startIndex: number
  readonly endIndex: number
}

export interface SheetsDeveloperMetadataLocation {
  readonly spreadsheet?: boolean
  readonly sheetId?: number
  readonly dimensionRange?: SheetsDimensionRange
  readonly locationType?: SheetsDeveloperMetadataLocationType
}

export interface SheetsDeveloperMetadataLookup {
  readonly locationType?: SheetsDeveloperMetadataLocationType
  readonly metadataLocation?: SheetsDeveloperMetadataLocation
  readonly locationMatchingStrategy?: SheetsDeveloperMetadataLocationMatchingStrategy
  readonly metadataId?: number
  readonly metadataKey?: string
  readonly metadataValue?: string
  readonly visibility?: SheetsDeveloperMetadataVisibility
}

/** A data filter must select by exactly one of these three fields. */
export interface SheetsDataFilter {
  readonly developerMetadataLookup?: SheetsDeveloperMetadataLookup
  readonly a1Range?: string
  readonly gridRange?: SheetsGridRange
}

export interface SheetsDeveloperMetadata {
  readonly metadataId?: number
  readonly metadataKey?: string
  readonly metadataValue?: string
  readonly location?: SheetsDeveloperMetadataLocation
  readonly visibility?: SheetsDeveloperMetadataVisibility
}

export interface SheetsSpreadsheetGetByDataFilterRequest {
  readonly dataFilters: readonly SheetsDataFilter[]
  readonly includeGridData?: boolean
  readonly excludeTablesInBandedRanges?: boolean
  readonly commentsViewMode?: SheetsCommentsViewMode
}

export type SheetsPartialResponseOptions = QueryParams & {
  readonly fields?: string
}

/** Every operation name accepted by `spreadsheets.batchUpdate`. */
export type SheetsBatchUpdateOperationName =
  | "updateSpreadsheetProperties"
  | "updateSheetProperties"
  | "updateDimensionProperties"
  | "updateNamedRange"
  | "repeatCell"
  | "addNamedRange"
  | "deleteNamedRange"
  | "addSheet"
  | "deleteSheet"
  | "autoFill"
  | "cutPaste"
  | "copyPaste"
  | "mergeCells"
  | "unmergeCells"
  | "updateBorders"
  | "updateCells"
  | "addFilterView"
  | "appendCells"
  | "clearBasicFilter"
  | "deleteDimension"
  | "deleteEmbeddedObject"
  | "deleteFilterView"
  | "duplicateFilterView"
  | "duplicateSheet"
  | "findReplace"
  | "insertDimension"
  | "insertRange"
  | "moveDimension"
  | "updateEmbeddedObjectPosition"
  | "pasteData"
  | "textToColumns"
  | "updateFilterView"
  | "deleteRange"
  | "appendDimension"
  | "addConditionalFormatRule"
  | "updateConditionalFormatRule"
  | "deleteConditionalFormatRule"
  | "sortRange"
  | "setDataValidation"
  | "setBasicFilter"
  | "addProtectedRange"
  | "updateProtectedRange"
  | "deleteProtectedRange"
  | "autoResizeDimensions"
  | "addChart"
  | "updateChartSpec"
  | "updateEmbeddedObjectBorder"
  | "addBanding"
  | "updateBanding"
  | "deleteBanding"
  | "createDeveloperMetadata"
  | "updateDeveloperMetadata"
  | "deleteDeveloperMetadata"
  | "randomizeRange"
  | "addDimensionGroup"
  | "deleteDimensionGroup"
  | "updateDimensionGroup"
  | "trimWhitespace"
  | "deleteDuplicates"
  | "addSlicer"
  | "updateSlicerSpec"
  | "addDataSource"
  | "updateDataSource"
  | "deleteDataSource"
  | "refreshDataSource"
  | "cancelDataSourceRefresh"
  | "addTable"
  | "updateTable"
  | "deleteTable"

export type SheetsBatchUpdateOperation = {
  readonly [Name in SheetsBatchUpdateOperationName]: Readonly<
    Record<Name, Readonly<Record<string, unknown>>>
  >
}[SheetsBatchUpdateOperationName]

export interface SheetsSpreadsheetBatchUpdateRequest {
  readonly requests: readonly SheetsBatchUpdateOperation[]
  readonly includeSpreadsheetInResponse?: boolean
  readonly responseRanges?: readonly string[]
  readonly responseIncludeGridData?: boolean
  readonly commentsViewMode?: SheetsCommentsViewMode
}

export interface SheetsSpreadsheetBatchUpdateResponse {
  readonly spreadsheetId: string
  readonly replies?: readonly Readonly<Record<string, unknown>>[]
  readonly updatedSpreadsheet?: SheetsSpreadsheet
  readonly commentUpdateState?: string
}

export interface SheetsValueRange {
  readonly range?: string
  readonly majorDimension?: SheetsDimension
  /** Google omits empty trailing rows and columns, so this may not be rectangular. */
  readonly values?: readonly (readonly SheetsCellValue[])[]
}

export interface SheetsValueRangeInput {
  readonly range?: string
  readonly majorDimension?: SheetsDimension
  readonly values: readonly (readonly SheetsInputCellValue[])[]
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

export interface SheetsValuesBatchGetByDataFilterRequest {
  readonly dataFilters: readonly SheetsDataFilter[]
  readonly majorDimension?: SheetsDimension
  readonly valueRenderOption?: SheetsValueRenderOption
  readonly dateTimeRenderOption?: SheetsDateTimeRenderOption
}

export interface SheetsMatchedValueRange {
  readonly dataFilters?: readonly SheetsDataFilter[]
  readonly valueRange?: SheetsValueRange
}

export interface SheetsBatchGetValuesByDataFilterResponse {
  readonly spreadsheetId: string
  readonly valueRanges?: readonly SheetsMatchedValueRange[]
}

export type SheetsValuesUpdateOptions = QueryParams & {
  readonly valueInputOption: SheetsValueInputOption
  readonly includeValuesInResponse?: boolean
  readonly responseValueRenderOption?: SheetsValueRenderOption
  readonly responseDateTimeRenderOption?: SheetsDateTimeRenderOption
}

export type SheetsValuesAppendOptions = SheetsValuesUpdateOptions & {
  readonly insertDataOption?: SheetsInsertDataOption
}

export interface SheetsUpdateValuesResponse {
  readonly spreadsheetId: string
  readonly updatedRange?: string
  readonly updatedRows?: number
  readonly updatedColumns?: number
  readonly updatedCells?: number
  readonly updatedData?: SheetsValueRange
}

export interface SheetsAppendValuesResponse {
  readonly spreadsheetId: string
  readonly tableRange?: string
  readonly updates?: SheetsUpdateValuesResponse
}

export interface SheetsClearValuesResponse {
  readonly spreadsheetId: string
  readonly clearedRange?: string
}

export interface SheetsBatchUpdateValuesRequest {
  readonly valueInputOption: SheetsValueInputOption
  readonly data: readonly SheetsValueRangeInput[]
  readonly includeValuesInResponse?: boolean
  readonly responseValueRenderOption?: SheetsValueRenderOption
  readonly responseDateTimeRenderOption?: SheetsDateTimeRenderOption
}

export interface SheetsDataFilterValueRange {
  readonly dataFilter: SheetsDataFilter
  readonly majorDimension?: SheetsDimension
  readonly values: readonly (readonly SheetsInputCellValue[])[]
}

export interface SheetsBatchUpdateValuesByDataFilterRequest {
  readonly valueInputOption: SheetsValueInputOption
  readonly data: readonly SheetsDataFilterValueRange[]
  readonly includeValuesInResponse?: boolean
  readonly responseValueRenderOption?: SheetsValueRenderOption
  readonly responseDateTimeRenderOption?: SheetsDateTimeRenderOption
}

export interface SheetsUpdateValuesByDataFilterResponse extends SheetsUpdateValuesResponse {
  readonly dataFilter?: SheetsDataFilter
}

export interface SheetsBatchUpdateValuesResponse {
  readonly spreadsheetId: string
  readonly totalUpdatedRows?: number
  readonly totalUpdatedColumns?: number
  readonly totalUpdatedCells?: number
  readonly totalUpdatedSheets?: number
  readonly responses?: readonly SheetsUpdateValuesResponse[]
}

export interface SheetsBatchUpdateValuesByDataFilterResponse
  extends Omit<SheetsBatchUpdateValuesResponse, "responses"> {
  readonly responses?: readonly SheetsUpdateValuesByDataFilterResponse[]
}

export interface SheetsBatchClearValuesRequest {
  readonly ranges: readonly string[]
}

export interface SheetsBatchClearValuesByDataFilterRequest {
  readonly dataFilters: readonly SheetsDataFilter[]
}

export interface SheetsBatchClearValuesResponse {
  readonly spreadsheetId: string
  readonly clearedRanges?: readonly string[]
}

export interface SheetsDeveloperMetadataSearchRequest {
  readonly dataFilters: readonly SheetsDataFilter[]
}

export interface SheetsMatchedDeveloperMetadata {
  readonly developerMetadata?: SheetsDeveloperMetadata
  readonly dataFilters?: readonly SheetsDataFilter[]
}

export interface SheetsDeveloperMetadataSearchResponse {
  readonly matchedDeveloperMetadata?: readonly SheetsMatchedDeveloperMetadata[]
}

export interface SheetsCopySheetRequest {
  readonly destinationSpreadsheetId: string
}
