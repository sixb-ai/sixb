import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocJsonObject,
  PandaDocLinkedObjectInput,
  PandaDocLinkedObjectListOptions,
} from "../types"

export interface DocumentLinkedObjectsResource {
  /** `GET /public/v1/documents/linked-objects` */
  listDocuments(options: PandaDocLinkedObjectListOptions): Promise<PandaDocJsonObject>
  /** `GET /public/v1/documents/{id}/linked-objects` */
  list(documentId: string): Promise<PandaDocJsonObject>
  /** `POST /public/v1/documents/{id}/linked-objects` */
  create(documentId: string, input: PandaDocLinkedObjectInput): Promise<PandaDocJsonObject>
  /** `DELETE /public/v1/documents/{id}/linked-objects/{linked_object_id}` */
  delete(documentId: string, linkedObjectId: string): Promise<void>
}

export function documentLinkedObjectsResource(http: PandaDocHttp): DocumentLinkedObjectsResource {
  return {
    listDocuments(options) {
      return http.get("public/v1/documents/linked-objects", options)
    },
    list(documentId) {
      return http.get(`public/v1/documents/${pathPart(documentId, "document id")}/linked-objects`)
    },
    create(documentId, input) {
      return http.post(
        `public/v1/documents/${pathPart(documentId, "document id")}/linked-objects`,
        input
      )
    },
    delete(documentId, linkedObjectId) {
      return http.delete(
        `public/v1/documents/${pathPart(documentId, "document id")}/linked-objects/${pathPart(
          linkedObjectId,
          "linked object id"
        )}`
      )
    },
  }
}
