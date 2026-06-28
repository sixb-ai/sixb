import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocDocumentAttachment,
  PandaDocDocumentAttachmentInput,
  PandaDocItemsResponse,
  PandaDocJsonObject,
} from "../types"

export interface DocumentAttachmentsResource {
  /** `GET /public/v1/documents/{id}/attachments` */
  list(documentId: string): Promise<PandaDocItemsResponse<PandaDocDocumentAttachment>>
  /** `POST /public/v1/documents/{id}/attachments` */
  create(
    documentId: string,
    input: PandaDocDocumentAttachmentInput
  ): Promise<PandaDocDocumentAttachment>
  /** `POST /public/v1/documents/{id}/attachments?upload` */
  createFromUpload(documentId: string, body: BodyInit): Promise<PandaDocDocumentAttachment>
  /** `GET /public/v1/documents/{id}/attachments/{attachment_id}` */
  details(documentId: string, attachmentId: string): Promise<PandaDocDocumentAttachment>
  /** `DELETE /public/v1/documents/{id}/attachments/{attachment_id}` */
  delete(documentId: string, attachmentId: string): Promise<void>
  /** `GET /public/v1/documents/{id}/attachments/{attachment_id}/download` */
  download(documentId: string, attachmentId: string): Promise<Response>
}

export function documentAttachmentsResource(http: PandaDocHttp): DocumentAttachmentsResource {
  return {
    list(documentId) {
      return http.get(`public/v1/documents/${pathPart(documentId, "document id")}/attachments`)
    },
    create(documentId, input) {
      return http.post(
        `public/v1/documents/${pathPart(documentId, "document id")}/attachments`,
        input
      )
    },
    createFromUpload(documentId, body) {
      return http.post(
        `public/v1/documents/${pathPart(documentId, "document id")}/attachments?upload`,
        body
      )
    },
    details(documentId, attachmentId) {
      return http.get(
        `public/v1/documents/${pathPart(documentId, "document id")}/attachments/${pathPart(
          attachmentId,
          "attachment id"
        )}`
      )
    },
    delete(documentId, attachmentId) {
      return http.delete(
        `public/v1/documents/${pathPart(documentId, "document id")}/attachments/${pathPart(
          attachmentId,
          "attachment id"
        )}`
      )
    },
    download(documentId, attachmentId) {
      return http.getRaw(
        `public/v1/documents/${pathPart(documentId, "document id")}/attachments/${pathPart(
          attachmentId,
          "attachment id"
        )}/download`
      )
    },
  }
}

export type DocumentAttachmentCreateResponse = PandaDocJsonObject
