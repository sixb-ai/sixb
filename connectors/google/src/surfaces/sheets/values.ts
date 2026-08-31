import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import type {
  SheetsAppendValuesResponse,
  SheetsBatchClearValuesByDataFilterRequest,
  SheetsBatchClearValuesRequest,
  SheetsBatchClearValuesResponse,
  SheetsBatchGetValuesByDataFilterResponse,
  SheetsBatchGetValuesResponse,
  SheetsBatchUpdateValuesByDataFilterRequest,
  SheetsBatchUpdateValuesByDataFilterResponse,
  SheetsBatchUpdateValuesRequest,
  SheetsBatchUpdateValuesResponse,
  SheetsClearValuesResponse,
  SheetsDataFilter,
  SheetsUpdateValuesResponse,
  SheetsValueRange,
  SheetsValueRangeInput,
  SheetsValuesAppendOptions,
  SheetsValuesBatchGetByDataFilterRequest,
  SheetsValuesBatchGetOptions,
  SheetsValuesGetOptions,
  SheetsValuesUpdateOptions,
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
  /** Read ranges selected by A1 ranges, grid ranges, or developer metadata. */
  batchGetByDataFilter(
    spreadsheetId: string,
    request: SheetsValuesBatchGetByDataFilterRequest
  ): Promise<SheetsBatchGetValuesByDataFilterResponse>
  /** Replace values in one range. */
  update(
    spreadsheetId: string,
    range: string,
    values: SheetsValueRangeInput,
    options: SheetsValuesUpdateOptions
  ): Promise<SheetsUpdateValuesResponse>
  /** Append rows after the range's logical table. */
  append(
    spreadsheetId: string,
    range: string,
    values: SheetsValueRangeInput,
    options: SheetsValuesAppendOptions
  ): Promise<SheetsAppendValuesResponse>
  /** Clear values while preserving formatting and validation. */
  clear(spreadsheetId: string, range: string): Promise<SheetsClearValuesResponse>
  /** Update multiple A1/R1C1 ranges in one request. */
  batchUpdate(
    spreadsheetId: string,
    request: SheetsBatchUpdateValuesRequest
  ): Promise<SheetsBatchUpdateValuesResponse>
  /** Update multiple ranges selected by data filters. */
  batchUpdateByDataFilter(
    spreadsheetId: string,
    request: SheetsBatchUpdateValuesByDataFilterRequest
  ): Promise<SheetsBatchUpdateValuesByDataFilterResponse>
  /** Clear multiple A1/R1C1 ranges. */
  batchClear(
    spreadsheetId: string,
    request: SheetsBatchClearValuesRequest
  ): Promise<SheetsBatchClearValuesResponse>
  /** Clear multiple ranges selected by data filters. */
  batchClearByDataFilter(
    spreadsheetId: string,
    request: SheetsBatchClearValuesByDataFilterRequest
  ): Promise<SheetsBatchClearValuesResponse>
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
      assertRanges(options.ranges, "options.ranges")
      return http.json("sheets", "GET", `${path}:batchGet`, { query: options })
    },
    batchGetByDataFilter(spreadsheetId, request) {
      const path = spreadsheetValuesPath(spreadsheetId)
      assertDataFilters(request.dataFilters)
      return http.json("sheets", "POST", `${path}:batchGetByDataFilter`, {
        body: request,
        retryable: true,
      })
    },
    update(spreadsheetId, range, values, options) {
      const path = spreadsheetValuesPath(spreadsheetId)
      return http.json("sheets", "PUT", `${path}/${pathSegment(range, "range")}`, {
        query: options,
        body: values,
        retryable: false,
      })
    },
    append(spreadsheetId, range, values, options) {
      const path = spreadsheetValuesPath(spreadsheetId)
      return http.json("sheets", "POST", `${path}/${pathSegment(range, "range")}:append`, {
        query: options,
        body: values,
        retryable: false,
      })
    },
    clear(spreadsheetId, range) {
      const path = spreadsheetValuesPath(spreadsheetId)
      return http.json("sheets", "POST", `${path}/${pathSegment(range, "range")}:clear`, {
        body: {},
        retryable: false,
      })
    },
    batchUpdate(spreadsheetId, request) {
      const path = spreadsheetValuesPath(spreadsheetId)
      assertItems(request.data, "request.data")
      for (const valueRange of request.data) {
        pathSegment(valueRange.range ?? "", "request.data item range")
      }
      return http.json("sheets", "POST", `${path}:batchUpdate`, {
        body: request,
        retryable: false,
      })
    },
    batchUpdateByDataFilter(spreadsheetId, request) {
      const path = spreadsheetValuesPath(spreadsheetId)
      assertItems(request.data, "request.data")
      for (const valueRange of request.data) {
        assertDataFilter(valueRange.dataFilter, "request.data item dataFilter")
      }
      return http.json("sheets", "POST", `${path}:batchUpdateByDataFilter`, {
        body: request,
        retryable: false,
      })
    },
    batchClear(spreadsheetId, request) {
      const path = spreadsheetValuesPath(spreadsheetId)
      assertRanges(request.ranges, "request.ranges")
      return http.json("sheets", "POST", `${path}:batchClear`, {
        body: request,
        retryable: false,
      })
    },
    batchClearByDataFilter(spreadsheetId, request) {
      const path = spreadsheetValuesPath(spreadsheetId)
      assertDataFilters(request.dataFilters)
      return http.json("sheets", "POST", `${path}:batchClearByDataFilter`, {
        body: request,
        retryable: false,
      })
    },
  }
}

function spreadsheetValuesPath(spreadsheetId: string): string {
  return `spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}/values`
}

function assertRanges(ranges: readonly string[], name: string): void {
  if (ranges.length === 0) {
    throw new Error(`[SixbGoogle] ${name} must contain at least one range.`)
  }
  for (const range of ranges) {
    pathSegment(range, `${name} item`)
  }
}

function assertItems(items: readonly unknown[], name: string): void {
  if (items.length === 0) {
    throw new Error(`[SixbGoogle] ${name} must contain at least one item.`)
  }
}

export function assertDataFilters(
  dataFilters: readonly SheetsDataFilter[],
  name = "request.dataFilters"
): void {
  assertItems(dataFilters, name)
  for (const dataFilter of dataFilters) {
    assertDataFilter(dataFilter, `${name} item`)
  }
}

function assertDataFilter(dataFilter: SheetsDataFilter, name: string): void {
  const selectors = [
    dataFilter.a1Range !== undefined,
    dataFilter.gridRange !== undefined,
    dataFilter.developerMetadataLookup !== undefined,
  ].filter(Boolean).length
  if (selectors !== 1) {
    throw new Error(
      `[SixbGoogle] ${name} must set exactly one of a1Range, gridRange, or developerMetadataLookup.`
    )
  }
  if (dataFilter.a1Range !== undefined) {
    pathSegment(dataFilter.a1Range, `${name}.a1Range`)
  }
}
