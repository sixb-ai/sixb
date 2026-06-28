import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type { PandaDocDocumentSettings, PandaDocJsonObject } from "../types"

export interface DocumentSettingsResource {
  /** `GET /public/v2/documents/{document_id}/settings` */
  get(documentId: string): Promise<PandaDocDocumentSettings>
  /** `PATCH /public/v2/documents/{document_id}/settings` */
  update(documentId: string, input: PandaDocJsonObject): Promise<PandaDocDocumentSettings>
}

export function documentSettingsResource(http: PandaDocHttp): DocumentSettingsResource {
  return {
    get(documentId) {
      return http.get(`public/v2/documents/${pathPart(documentId, "document id")}/settings`)
    },
    update(documentId, input) {
      return http.patch(
        `public/v2/documents/${pathPart(documentId, "document id")}/settings`,
        input
      )
    },
  }
}
