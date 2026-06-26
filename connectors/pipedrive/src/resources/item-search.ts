import type { PipedriveHttp } from "../http"
import type {
  PipedriveAdditionalData,
  PipedriveItemSearchByFieldOptions,
  PipedriveItemSearchOptions,
  PipedriveResponse,
  PipedriveSearchResponse,
  PipedriveSearchResult,
} from "../types"

export interface ItemSearchResource {
  /** `GET /itemSearch` */
  search(options: PipedriveItemSearchOptions): Promise<PipedriveSearchResponse>
  /** `GET /itemSearch/field` */
  searchByField(
    options: PipedriveItemSearchByFieldOptions
  ): Promise<PipedriveResponse<readonly PipedriveSearchResult[], PipedriveAdditionalData>>
}

export function itemSearchResource(http: PipedriveHttp): ItemSearchResource {
  return {
    search(options) {
      return http.get("v2", "itemSearch", options)
    },
    searchByField(options) {
      return http.get("v2", "itemSearch/field", options)
    },
  }
}
