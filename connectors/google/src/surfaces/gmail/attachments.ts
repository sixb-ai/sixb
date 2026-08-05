import type { GoogleHttp } from "../../http"
import { pathSegment } from "../../http"
import type { MessagePartBody } from "../../types/gmail"
import { gmailResourcePath } from "./paths"

export interface GmailAttachmentsResource {
  /** `GET /users/{userId}/messages/{messageId}/attachments/{id}`. */
  get(userId: string, messageId: string, id: string): Promise<MessagePartBody>
}

export function gmailAttachmentsResource(http: GoogleHttp): GmailAttachmentsResource {
  return {
    get(userId, messageId, id) {
      return http.json<MessagePartBody>(
        "gmail",
        "GET",
        `${gmailResourcePath(userId, "messages", messageId, "messageId")}/attachments/${pathSegment(id, "attachmentId")}`
      )
    },
  }
}
