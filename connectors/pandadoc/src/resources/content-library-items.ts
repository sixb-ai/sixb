import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import { listAllPages } from "../pagination"
import type {
  PandaDocContentLibraryItem,
  PandaDocContentLibraryItemInput,
  PandaDocContentLibraryItemListOptions,
  PandaDocResultsResponse,
} from "../types"

export interface ContentLibraryItemsResource {
  /** `GET /public/v1/content-library-items` */
  list(
    options?: PandaDocContentLibraryItemListOptions
  ): Promise<PandaDocResultsResponse<PandaDocContentLibraryItem>>
  listAll(
    options?: PandaDocContentLibraryItemListOptions
  ): AsyncIterable<PandaDocContentLibraryItem>
  /** `POST /public/v1/content-library-items` */
  create(input: PandaDocContentLibraryItemInput): Promise<PandaDocContentLibraryItem>
  /** `POST /public/v1/content-library-items?upload` */
  createFromUpload(body: BodyInit): Promise<PandaDocContentLibraryItem>
  /** `GET /public/v1/content-library-items/{id}` */
  status(id: string): Promise<PandaDocContentLibraryItem>
  /** `GET /public/v1/content-library-items/{id}/details` */
  details(id: string): Promise<PandaDocContentLibraryItem>
}

export function contentLibraryItemsResource(http: PandaDocHttp): ContentLibraryItemsResource {
  const resource: ContentLibraryItemsResource = {
    list(options) {
      return http.get("public/v1/content-library-items", options)
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.results, options)
    },
    create(input) {
      return http.post("public/v1/content-library-items", input)
    },
    createFromUpload(body) {
      return http.post("public/v1/content-library-items?upload", body)
    },
    status(id) {
      return http.get(`public/v1/content-library-items/${pathPart(id, "content library item id")}`)
    },
    details(id) {
      return http.get(
        `public/v1/content-library-items/${pathPart(id, "content library item id")}/details`
      )
    },
  }

  return resource
}
