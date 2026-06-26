import type { PipedriveHttp } from "../http"
import { pathPart } from "../http"
import { listAllCursor } from "../pagination"
import type {
  PipedriveCursorPage,
  PipedriveDeal,
  PipedriveDealGetOptions,
  PipedriveDealListOptions,
  PipedriveDealSearchItem,
  PipedriveDealSearchOptions,
  PipedriveResponse,
  PipedriveSearchResponse,
} from "../types"

export interface DealsResource {
  /** `GET /deals` */
  list(options?: PipedriveDealListOptions): Promise<PipedriveCursorPage<PipedriveDeal>>
  listAll(options?: PipedriveDealListOptions): AsyncIterable<PipedriveDeal>
  /** `GET /deals/archived` */
  listArchived(options?: PipedriveDealListOptions): Promise<PipedriveCursorPage<PipedriveDeal>>
  listAllArchived(options?: PipedriveDealListOptions): AsyncIterable<PipedriveDeal>
  /** `GET /deals/{id}` */
  get(id: number, options?: PipedriveDealGetOptions): Promise<PipedriveResponse<PipedriveDeal>>
  /** `GET /deals/search` */
  search(
    options: PipedriveDealSearchOptions
  ): Promise<PipedriveSearchResponse<PipedriveDealSearchItem>>
}

export function dealsResource(http: PipedriveHttp): DealsResource {
  const resource: DealsResource = {
    list(options) {
      return http.get("v2", "deals", options)
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    listArchived(options) {
      return http.get("v2", "deals/archived", options)
    },
    listAllArchived(options) {
      return listAllCursor(resource.listArchived, options)
    },
    get(id, options) {
      return http.get("v2", `deals/${pathPart(id, "deal id")}`, options)
    },
    search(options) {
      return http.get("v2", "deals/search", options)
    },
  }

  return resource
}
