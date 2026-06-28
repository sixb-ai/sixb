import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type { PandaDocJsonObject } from "../types"

export interface DocumentFieldsResource {
  /** `GET /public/v1/documents/{id}/fields` */
  list(documentId: string): Promise<PandaDocJsonObject>
  /** `POST /public/v1/documents/{id}/fields` */
  create(documentId: string, input: PandaDocJsonObject): Promise<PandaDocJsonObject>
  /** `PATCH /public/v1/documents/{id}/fields` */
  updateAssignments(documentId: string, input: PandaDocJsonObject): Promise<PandaDocJsonObject>
}

export function documentFieldsResource(http: PandaDocHttp): DocumentFieldsResource {
  return {
    list(documentId) {
      return http.get(`public/v1/documents/${pathPart(documentId, "document id")}/fields`)
    },
    create(documentId, input) {
      return http.post(`public/v1/documents/${pathPart(documentId, "document id")}/fields`, input)
    },
    updateAssignments(documentId, input) {
      return http.patch(`public/v1/documents/${pathPart(documentId, "document id")}/fields`, input)
    },
  }
}
