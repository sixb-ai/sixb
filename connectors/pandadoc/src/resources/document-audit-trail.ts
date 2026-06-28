import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type { PandaDocAuditTrailResponse, QueryParams } from "../types"

export interface DocumentAuditTrailResource {
  /** `GET /public/v2/documents/{document_id}/audit-trail` */
  list(documentId: string, options?: QueryParams): Promise<PandaDocAuditTrailResponse>
}

export function documentAuditTrailResource(http: PandaDocHttp): DocumentAuditTrailResource {
  return {
    list(documentId, options) {
      return http.get(
        `public/v2/documents/${pathPart(documentId, "document id")}/audit-trail`,
        options
      )
    },
  }
}
