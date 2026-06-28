import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocDocumentSection,
  PandaDocDocumentSectionUpload,
  PandaDocItemsResponse,
  PandaDocJsonObject,
  PandaDocSectionsListOptions,
} from "../types"

export interface DocumentSectionsResource {
  /** `GET /public/v1/documents/{document_id}/sections` */
  list(
    documentId: string,
    options?: PandaDocSectionsListOptions
  ): Promise<PandaDocItemsResponse<PandaDocDocumentSection>>
  /** `POST /public/v1/documents/{document_id}/sections/uploads` */
  upload(documentId: string, input: PandaDocJsonObject): Promise<PandaDocDocumentSectionUpload>
  /** `POST /public/v1/documents/{document_id}/sections/uploads?upload` */
  uploadFile(documentId: string, body: BodyInit): Promise<PandaDocDocumentSectionUpload>
  /** `GET /public/v1/documents/{document_id}/sections/uploads/{upload_id}` */
  uploadDetails(documentId: string, uploadId: string): Promise<PandaDocDocumentSectionUpload>
  /** `GET /public/v1/documents/{document_id}/sections/{section_id}` */
  get(documentId: string, sectionId: string): Promise<PandaDocDocumentSection>
  /** `DELETE /public/v1/documents/{document_id}/sections/{section_id}` */
  delete(documentId: string, sectionId: string): Promise<void>
}

export function documentSectionsResource(http: PandaDocHttp): DocumentSectionsResource {
  return {
    list(documentId, options) {
      return http.get(
        `public/v1/documents/${pathPart(documentId, "document id")}/sections`,
        options
      )
    },
    upload(documentId, input) {
      return http.post(
        `public/v1/documents/${pathPart(documentId, "document id")}/sections/uploads`,
        input
      )
    },
    uploadFile(documentId, body) {
      return http.post(
        `public/v1/documents/${pathPart(documentId, "document id")}/sections/uploads?upload`,
        body
      )
    },
    uploadDetails(documentId, uploadId) {
      return http.get(
        `public/v1/documents/${pathPart(documentId, "document id")}/sections/uploads/${pathPart(
          uploadId,
          "upload id"
        )}`
      )
    },
    get(documentId, sectionId) {
      return http.get(
        `public/v1/documents/${pathPart(documentId, "document id")}/sections/${pathPart(
          sectionId,
          "section id"
        )}`
      )
    },
    delete(documentId, sectionId) {
      return http.delete(
        `public/v1/documents/${pathPart(documentId, "document id")}/sections/${pathPart(
          sectionId,
          "section id"
        )}`
      )
    },
  }
}
