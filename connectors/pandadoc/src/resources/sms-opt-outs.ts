import type { PandaDocHttp } from "../http"
import type {
  PandaDocResultsResponse,
  PandaDocSmsOptOut,
  PandaDocSmsOptOutListOptions,
} from "../types"

export interface SmsOptOutsResource {
  /** `GET /public/v1/sms-opt-outs` */
  listRecent(
    options?: PandaDocSmsOptOutListOptions
  ): Promise<PandaDocResultsResponse<PandaDocSmsOptOut>>
}

export function smsOptOutsResource(http: PandaDocHttp): SmsOptOutsResource {
  return {
    listRecent(options) {
      return http.get("public/v1/sms-opt-outs", options)
    },
  }
}
