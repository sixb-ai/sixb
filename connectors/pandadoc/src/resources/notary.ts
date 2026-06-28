import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocJsonObject,
  PandaDocNotarizationRequest,
  PandaDocNotarizationRequestInput,
  PandaDocNotarizationRequestListOptions,
  PandaDocNotary,
  PandaDocNotaryListOptions,
  PandaDocResultsResponse,
} from "../types"

export interface NotaryResource {
  /** `GET /public/v2/notary/notaries` */
  listNotaries(
    options?: PandaDocNotaryListOptions
  ): Promise<PandaDocResultsResponse<PandaDocNotary>>
  /** `GET /public/v2/notary/notarization-requests` */
  listNotarizationRequests(
    options?: PandaDocNotarizationRequestListOptions
  ): Promise<PandaDocResultsResponse<PandaDocNotarizationRequest>>
  /** `POST /public/v2/notary/notarization-requests` */
  createNotarizationRequest(
    input: PandaDocNotarizationRequestInput
  ): Promise<PandaDocNotarizationRequest>
  /** `GET /public/v2/notary/notarization-requests/{session_request_id}` */
  notarizationRequestDetails(sessionRequestId: string): Promise<PandaDocNotarizationRequest>
  /** `DELETE /public/v2/notary/notarization-requests/{session_request_id}` */
  deleteNotarizationRequest(sessionRequestId: string): Promise<PandaDocJsonObject>
}

export function notaryResource(http: PandaDocHttp): NotaryResource {
  return {
    listNotaries(options) {
      return http.get("public/v2/notary/notaries", options)
    },
    listNotarizationRequests(options) {
      return http.get("public/v2/notary/notarization-requests", options)
    },
    createNotarizationRequest(input) {
      return http.post("public/v2/notary/notarization-requests", input)
    },
    notarizationRequestDetails(sessionRequestId) {
      return http.get(
        `public/v2/notary/notarization-requests/${pathPart(sessionRequestId, "session request id")}`
      )
    },
    deleteNotarizationRequest(sessionRequestId) {
      return http.delete(
        `public/v2/notary/notarization-requests/${pathPart(sessionRequestId, "session request id")}`
      )
    },
  }
}
