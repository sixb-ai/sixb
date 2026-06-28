import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type { PandaDocJsonObject } from "../types"

export interface DocumentDsvResource {
  /** `POST /public/v2/dsv/{document_id}/add-named-items` */
  addNamedItems(documentId: string, input: PandaDocJsonObject): Promise<PandaDocJsonObject>
}

export function documentDsvResource(http: PandaDocHttp): DocumentDsvResource {
  return {
    addNamedItems(documentId, input) {
      return http.post(
        `public/v2/dsv/${pathPart(documentId, "document id")}/add-named-items`,
        input
      )
    },
  }
}
