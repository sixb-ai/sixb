import type { PandaDocHttp } from "../http"
import { pathPart } from "../http"
import type {
  PandaDocAutoReminderSettings,
  PandaDocAutoReminderStatus,
  PandaDocJsonObject,
} from "../types"

export interface DocumentAutoRemindersResource {
  /** `GET /public/v1/documents/{document_id}/auto-reminders` */
  get(documentId: string): Promise<PandaDocAutoReminderSettings>
  /** `PATCH /public/v1/documents/{document_id}/auto-reminders` */
  update(documentId: string, input: PandaDocJsonObject): Promise<PandaDocAutoReminderSettings>
  /** `GET /public/v1/documents/{document_id}/auto-reminders/status` */
  status(documentId: string): Promise<PandaDocAutoReminderStatus>
}

export function documentAutoRemindersResource(http: PandaDocHttp): DocumentAutoRemindersResource {
  return {
    get(documentId) {
      return http.get(`public/v1/documents/${pathPart(documentId, "document id")}/auto-reminders`)
    },
    update(documentId, input) {
      return http.patch(
        `public/v1/documents/${pathPart(documentId, "document id")}/auto-reminders`,
        input
      )
    },
    status(documentId) {
      return http.get(
        `public/v1/documents/${pathPart(documentId, "document id")}/auto-reminders/status`
      )
    },
  }
}
