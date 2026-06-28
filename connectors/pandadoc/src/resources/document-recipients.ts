import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type { PandaDocJsonObject } from "../types"

export interface DocumentRecipientsResource {
  /** `POST /public/v1/documents/{id}/recipients` */
  add(documentId: string, input: PandaDocJsonObject): Promise<PandaDocJsonObject>
  /** `PATCH /public/v1/documents/{id}/recipients/recipient/{recipient_id}` */
  update(
    documentId: string,
    recipientId: string,
    input: PandaDocJsonObject
  ): Promise<PandaDocJsonObject>
  /** `DELETE /public/v1/documents/{id}/recipients/{recipient_id}` */
  delete(documentId: string, recipientId: string): Promise<void>
  /** `POST /public/v1/documents/{id}/recipients/{recipient_id}/reassign` */
  reassign(
    documentId: string,
    recipientId: string,
    input: PandaDocJsonObject
  ): Promise<PandaDocJsonObject>
}

export function documentRecipientsResource(http: PandaDocHttp): DocumentRecipientsResource {
  return {
    add(documentId, input) {
      return http.post(
        `public/v1/documents/${pathPart(documentId, "document id")}/recipients`,
        input
      )
    },
    update(documentId, recipientId, input) {
      return http.patch(
        `public/v1/documents/${pathPart(documentId, "document id")}/recipients/recipient/${pathPart(
          recipientId,
          "recipient id"
        )}`,
        input
      )
    },
    delete(documentId, recipientId) {
      return http.delete(
        `public/v1/documents/${pathPart(documentId, "document id")}/recipients/${pathPart(
          recipientId,
          "recipient id"
        )}`
      )
    },
    reassign(documentId, recipientId, input) {
      return http.post(
        `public/v1/documents/${pathPart(documentId, "document id")}/recipients/${pathPart(
          recipientId,
          "recipient id"
        )}/reassign`,
        input
      )
    },
  }
}
