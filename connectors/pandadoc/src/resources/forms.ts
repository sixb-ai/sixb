import type { PandaDocHttp } from "../http"
import { listAllPages } from "../pagination"
import type { PandaDocForm, PandaDocFormListOptions, PandaDocResultsResponse } from "../types"

export interface FormsResource {
  /** `GET /public/v1/forms` */
  list(options?: PandaDocFormListOptions): Promise<PandaDocResultsResponse<PandaDocForm>>
  listAll(options?: PandaDocFormListOptions): AsyncIterable<PandaDocForm>
}

export function formsResource(http: PandaDocHttp): FormsResource {
  const resource: FormsResource = {
    list(options) {
      return http.get("public/v1/forms", options)
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.results, options)
    },
  }

  return resource
}
