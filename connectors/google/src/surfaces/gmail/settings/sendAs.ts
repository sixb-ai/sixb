import type { GoogleHttp } from "../../../http"
import type { ListSendAsResponse, SendAs } from "../../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "../paths"
import { type GmailSmimeInfoResource, gmailSmimeInfoResource } from "./smimeInfo"

const COLLECTION = "settings/sendAs"

export interface GmailSendAsResource {
  readonly smimeInfo: GmailSmimeInfoResource
  list(userId: string): Promise<ListSendAsResponse>
  get(userId: string, sendAsEmail: string): Promise<SendAs>
  create(userId: string, sendAs: SendAs): Promise<SendAs>
  update(userId: string, sendAsEmail: string, sendAs: SendAs): Promise<SendAs>
  patch(userId: string, sendAsEmail: string, sendAs: Partial<SendAs>): Promise<SendAs>
  delete(userId: string, sendAsEmail: string): Promise<void>
  verify(userId: string, sendAsEmail: string): Promise<void>
}

export function gmailSendAsResource(http: GoogleHttp): GmailSendAsResource {
  return {
    smimeInfo: gmailSmimeInfoResource(http),
    list(userId) {
      return http.json<ListSendAsResponse>("gmail", "GET", gmailCollectionPath(userId, COLLECTION))
    },
    get(userId, sendAsEmail) {
      return http.json<SendAs>(
        "gmail",
        "GET",
        gmailResourcePath(userId, COLLECTION, sendAsEmail, "sendAsEmail")
      )
    },
    create(userId, sendAs) {
      return http.json<SendAs>("gmail", "POST", gmailCollectionPath(userId, COLLECTION), {
        body: sendAs,
      })
    },
    update(userId, sendAsEmail, sendAs) {
      return http.json<SendAs>(
        "gmail",
        "PUT",
        gmailResourcePath(userId, COLLECTION, sendAsEmail, "sendAsEmail"),
        { body: sendAs }
      )
    },
    patch(userId, sendAsEmail, sendAs) {
      return http.json<SendAs>(
        "gmail",
        "PATCH",
        gmailResourcePath(userId, COLLECTION, sendAsEmail, "sendAsEmail"),
        { body: sendAs }
      )
    },
    delete(userId, sendAsEmail) {
      return http.json<void>(
        "gmail",
        "DELETE",
        gmailResourcePath(userId, COLLECTION, sendAsEmail, "sendAsEmail")
      )
    },
    verify(userId, sendAsEmail) {
      return http.json<void>(
        "gmail",
        "POST",
        gmailResourcePath(userId, COLLECTION, sendAsEmail, "sendAsEmail", "/verify")
      )
    },
  }
}
