import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import type {
  SheetsDeveloperMetadata,
  SheetsDeveloperMetadataSearchRequest,
  SheetsDeveloperMetadataSearchResponse,
} from "../../types/sheets"
import { assertDataFilters } from "./values"

export interface SheetsDeveloperMetadataResource {
  /** Get one developer metadata entry by its numeric id. */
  get(spreadsheetId: string, metadataId: number): Promise<SheetsDeveloperMetadata>
  /** Search developer metadata by location, id, key, value, or visibility. */
  search(
    spreadsheetId: string,
    request: SheetsDeveloperMetadataSearchRequest
  ): Promise<SheetsDeveloperMetadataSearchResponse>
}

export function sheetsDeveloperMetadataResource(http: GoogleHttp): SheetsDeveloperMetadataResource {
  return {
    get(spreadsheetId, metadataId) {
      const path = developerMetadataPath(spreadsheetId)
      return http.json("sheets", "GET", `${path}/${integerId(metadataId, "metadataId")}`)
    },
    search(spreadsheetId, request) {
      const path = developerMetadataPath(spreadsheetId)
      assertDataFilters(request.dataFilters)
      return http.json("sheets", "POST", `${path}:search`, {
        body: request,
        retryable: true,
      })
    },
  }
}

function developerMetadataPath(spreadsheetId: string): string {
  return `spreadsheets/${pathSegment(spreadsheetId, "spreadsheetId")}/developerMetadata`
}

function integerId(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`[SixbGoogle] ${name} must be a non-negative safe integer.`)
  }
  return String(value)
}
