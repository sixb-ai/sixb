import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import { listAllPages } from "../pagination"
import type {
  PandaDocBulkDeleteDocumentInput,
  PandaDocBulkDeleteDocumentsResponse,
  PandaDocDocumentCreateInput,
  PandaDocDocumentCreateOptions,
  PandaDocDocumentCreateResponse,
  PandaDocDocumentDetails,
  PandaDocDocumentDownloadOptions,
  PandaDocDocumentEditingSessionInput,
  PandaDocDocumentListOptions,
  PandaDocDocumentOwnershipInput,
  PandaDocDocumentSendInput,
  PandaDocDocumentSessionInput,
  PandaDocDocumentStatus,
  PandaDocDocumentStatusChangeInput,
  PandaDocDocumentStatusCode,
  PandaDocDocumentSummary,
  PandaDocESignDisclosure,
  PandaDocJsonObject,
  PandaDocResultsResponse,
  QueryParams,
  QueryValue,
} from "../types"

export interface DocumentsResource {
  /** `GET /public/v1/documents` */
  list(
    options?: PandaDocDocumentListOptions
  ): Promise<PandaDocResultsResponse<PandaDocDocumentSummary>>
  listAll(options?: PandaDocDocumentListOptions): AsyncIterable<PandaDocDocumentSummary>
  /** `POST /public/v1/documents` */
  create(
    input: PandaDocDocumentCreateInput,
    options?: PandaDocDocumentCreateOptions
  ): Promise<PandaDocDocumentCreateResponse>
  /** `POST /public/v1/documents?upload` */
  createFromUpload(
    body: BodyInit,
    options?: PandaDocDocumentCreateOptions
  ): Promise<PandaDocDocumentCreateResponse>
  /** `POST /public/v1/documents?upload-markdown` */
  createFromMarkdownUpload(
    body: BodyInit,
    options?: PandaDocDocumentCreateOptions
  ): Promise<PandaDocDocumentCreateResponse>
  /** `DELETE /public/v1/documents` */
  bulkDelete(
    input: readonly PandaDocBulkDeleteDocumentInput[]
  ): Promise<PandaDocBulkDeleteDocumentsResponse>
  /** `GET /public/v1/documents/{id}` */
  status(id: string): Promise<PandaDocDocumentSummary>
  /** `GET /public/v1/documents/{id}/details` */
  details(id: string): Promise<PandaDocDocumentDetails>
  /** `PATCH /public/v1/documents/{id}` */
  update(id: string, input: PandaDocJsonObject): Promise<PandaDocDocumentDetails>
  /** `DELETE /public/v1/documents/{id}` */
  delete(id: string): Promise<void>
  /** `PATCH /public/v1/documents/{id}/status` */
  changeStatus(id: string, input: PandaDocDocumentStatusChangeInput): Promise<void>
  /** `PATCH /public/v1/documents/{id}/status?upload` */
  changeStatusWithUpload(id: string, body: BodyInit): Promise<void>
  /** `POST /public/v1/documents/{id}/draft` */
  moveToDraft(id: string): Promise<PandaDocDocumentSummary>
  /** `GET /public/v1/documents/{document_id}/esign-disclosure` */
  eSignDisclosure(id: string): Promise<PandaDocESignDisclosure>
  /** `POST /public/v1/documents/{id}/send` */
  send(id: string, input?: PandaDocDocumentSendInput): Promise<PandaDocJsonObject>
  /** `POST /public/v1/documents/{id}/session` */
  createSession(id: string, input: PandaDocDocumentSessionInput): Promise<PandaDocJsonObject>
  /** `POST /public/v1/documents/{id}/editing-sessions` */
  createEditingSession(
    id: string,
    input: PandaDocDocumentEditingSessionInput
  ): Promise<PandaDocJsonObject>
  /** `GET /public/v1/documents/{id}/download` */
  download(id: string, options?: PandaDocDocumentDownloadOptions): Promise<Response>
  /** `GET /public/v1/documents/{id}/download-protected` */
  downloadProtected(id: string, options?: PandaDocDocumentDownloadOptions): Promise<Response>
  /** `POST /public/v1/documents/{id}/move-to-folder/{folder_id}` */
  moveToFolder(id: string, folderId: string): Promise<PandaDocDocumentSummary>
  /** `PATCH /public/v1/documents/{id}/ownership` */
  transferOwnership(id: string, input: PandaDocDocumentOwnershipInput): Promise<PandaDocJsonObject>
  /** `PATCH /public/v1/documents/ownership` */
  transferAllOwnership(input: PandaDocDocumentOwnershipInput): Promise<PandaDocJsonObject>
  /** `POST /public/v1/documents/{id}/append-content-library-item` */
  appendContentLibraryItem(id: string, input: PandaDocJsonObject): Promise<PandaDocJsonObject>
  /** `POST /public/v1/documents/{document_id}/send-reminder` */
  sendReminder(id: string, input?: PandaDocJsonObject): Promise<PandaDocJsonObject>
}

export function documentsResource(http: PandaDocHttp): DocumentsResource {
  const resource: DocumentsResource = {
    list(options) {
      return http.get("public/v1/documents", documentListQuery(options))
    },
    listAll(options) {
      return listAllPages(resource.list, (page) => page.results, options)
    },
    create(input, options) {
      return http.post("public/v1/documents", input, optionsQuery(options))
    },
    createFromUpload(body, options) {
      return http.post("public/v1/documents?upload", body, optionsQuery(options))
    },
    createFromMarkdownUpload(body, options) {
      return http.post("public/v1/documents?upload-markdown", body, optionsQuery(options))
    },
    bulkDelete(input) {
      return http.delete("public/v1/documents", undefined, input)
    },
    status(id) {
      return http.get(`public/v1/documents/${pathPart(id, "document id")}`)
    },
    details(id) {
      return http.get(`public/v1/documents/${pathPart(id, "document id")}/details`)
    },
    update(id, input) {
      return http.patch(`public/v1/documents/${pathPart(id, "document id")}`, input)
    },
    delete(id) {
      return http.delete(`public/v1/documents/${pathPart(id, "document id")}`)
    },
    changeStatus(id, input) {
      return http.patch(`public/v1/documents/${pathPart(id, "document id")}/status`, input)
    },
    changeStatusWithUpload(id, body) {
      return http.patch(`public/v1/documents/${pathPart(id, "document id")}/status?upload`, body)
    },
    moveToDraft(id) {
      return http.post(`public/v1/documents/${pathPart(id, "document id")}/draft`)
    },
    eSignDisclosure(id) {
      return http.get(`public/v1/documents/${pathPart(id, "document id")}/esign-disclosure`)
    },
    send(id, input = {}) {
      return http.post(`public/v1/documents/${pathPart(id, "document id")}/send`, input)
    },
    createSession(id, input) {
      return http.post(`public/v1/documents/${pathPart(id, "document id")}/session`, input)
    },
    createEditingSession(id, input) {
      return http.post(`public/v1/documents/${pathPart(id, "document id")}/editing-sessions`, input)
    },
    download(id, options) {
      return http.getRaw(`public/v1/documents/${pathPart(id, "document id")}/download`, options)
    },
    downloadProtected(id, options) {
      return http.getRaw(
        `public/v1/documents/${pathPart(id, "document id")}/download-protected`,
        options
      )
    },
    moveToFolder(id, folderId) {
      return http.post(
        `public/v1/documents/${pathPart(id, "document id")}/move-to-folder/${pathPart(
          folderId,
          "folder id"
        )}`
      )
    },
    transferOwnership(id, input) {
      return http.patch(`public/v1/documents/${pathPart(id, "document id")}/ownership`, input)
    },
    transferAllOwnership(input) {
      return http.patch("public/v1/documents/ownership", input)
    },
    appendContentLibraryItem(id, input) {
      return http.post(
        `public/v1/documents/${pathPart(id, "document id")}/append-content-library-item`,
        input
      )
    },
    sendReminder(id, input = {}) {
      return http.post(`public/v1/documents/${pathPart(id, "document id")}/send-reminder`, input)
    },
  }

  return resource
}

function optionsQuery(options: PandaDocDocumentCreateOptions | undefined): QueryParams | undefined {
  if (!options) {
    return undefined
  }

  return {
    editor_ver: options.editor_ver,
    use_form_field_properties: options.use_form_field_properties,
  }
}

function documentListQuery(
  options: PandaDocDocumentListOptions | undefined
): QueryParams | undefined {
  if (!options) {
    return undefined
  }

  return {
    ...options,
    status: statusQueryValue(options.status),
    status__ne: statusQueryValue(options.status__ne),
  }
}

function statusQueryValue(
  status: PandaDocDocumentStatusCode | PandaDocDocumentStatus | undefined
): QueryValue {
  if (status === undefined || typeof status === "number") {
    return status
  }

  return documentStatusCode[status] ?? status
}

const documentStatusCode: Partial<Record<PandaDocDocumentStatus, PandaDocDocumentStatusCode>> = {
  "document.draft": 0,
  "document.sent": 1,
  "document.completed": 2,
  "document.uploaded": 3,
  "document.error": 4,
  "document.viewed": 5,
  "document.waiting_approval": 6,
  "document.approved": 7,
  "document.rejected": 8,
  "document.waiting_pay": 9,
  "document.paid": 10,
  "document.voided": 11,
  "document.declined": 12,
  "document.external_review": 13,
}
