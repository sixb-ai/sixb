import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type { PandaDocJsonObject } from "../types"

export interface QuotesResource {
  /** `PUT /public/v1/documents/{document_id}/quotes/{quote_id}` */
  update(
    documentId: string,
    quoteId: string,
    input: PandaDocJsonObject
  ): Promise<PandaDocJsonObject>
}

export function quotesResource(http: PandaDocHttp): QuotesResource {
  return {
    update(documentId, quoteId, input) {
      return http.put(
        `public/v1/documents/${pathPart(documentId, "document id")}/quotes/${pathPart(
          quoteId,
          "quote id"
        )}`,
        input
      )
    },
  }
}
