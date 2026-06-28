import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocAiDocumentSearchOptions,
  PandaDocDocumentAiMetadataOptions,
  PandaDocDocumentContentOptions,
  PandaDocDocumentSummaryOptions,
  PandaDocDocxExportTask,
  PandaDocJsonObject,
  PandaDocResultsResponse,
} from "../types"

export interface BetaDocumentsResource {
  /** `POST /public/beta/documents/{document_id}/docx-export-tasks` */
  createDocxExportTask(documentId: string): Promise<PandaDocDocxExportTask>
  /** `GET /public/beta/documents/{document_id}/docx-export-tasks/{task_id}` */
  getDocxExportTask(documentId: string, taskId: string): Promise<PandaDocDocxExportTask>
  /** `GET /public/beta/documents/{document_id}/summary` */
  summary(documentId: string, options: PandaDocDocumentSummaryOptions): Promise<PandaDocJsonObject>
  /** `GET /public/beta/documents/{document_id}/content` */
  content(documentId: string, options: PandaDocDocumentContentOptions): Promise<PandaDocJsonObject>
  /** `GET /public/beta/documents/{document_id}/ai-metadata` */
  aiMetadata(
    documentId: string,
    options?: PandaDocDocumentAiMetadataOptions
  ): Promise<PandaDocJsonObject>
  /** `GET /public/beta/documents/search` */
  search(
    options: PandaDocAiDocumentSearchOptions
  ): Promise<PandaDocResultsResponse<PandaDocJsonObject>>
}

export function betaDocumentsResource(http: PandaDocHttp): BetaDocumentsResource {
  return {
    createDocxExportTask(documentId) {
      return http.post(
        `public/beta/documents/${pathPart(documentId, "document id")}/docx-export-tasks`
      )
    },
    getDocxExportTask(documentId, taskId) {
      return http.get(
        `public/beta/documents/${pathPart(documentId, "document id")}/docx-export-tasks/${pathPart(
          taskId,
          "task id"
        )}`
      )
    },
    summary(documentId, options) {
      return http.get(
        `public/beta/documents/${pathPart(documentId, "document id")}/summary`,
        options
      )
    },
    content(documentId, options) {
      return http.get(
        `public/beta/documents/${pathPart(documentId, "document id")}/content`,
        options
      )
    },
    aiMetadata(documentId, options) {
      return http.get(
        `public/beta/documents/${pathPart(documentId, "document id")}/ai-metadata`,
        options
      )
    },
    search(options) {
      return http.get("public/beta/documents/search", options)
    },
  }
}
