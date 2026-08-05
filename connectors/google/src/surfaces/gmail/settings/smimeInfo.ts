import type { GoogleHttp } from "../../../http"
import { pathSegment } from "../../../http"
import type { ListSmimeInfoResponse, SmimeInfo } from "../../../types/gmail"
import { gmailCollectionPath } from "../paths"

function collectionPath(userId: string, sendAsEmail: string, suffix = ""): string {
  return gmailCollectionPath(
    userId,
    `settings/sendAs/${pathSegment(sendAsEmail, "sendAsEmail")}/smimeInfo`,
    suffix
  )
}

function resourcePath(userId: string, sendAsEmail: string, id: string, suffix = ""): string {
  return collectionPath(userId, sendAsEmail, `/${pathSegment(id, "smimeInfoId")}${suffix}`)
}

export interface GmailSmimeInfoResource {
  list(userId: string, sendAsEmail: string): Promise<ListSmimeInfoResponse>
  get(userId: string, sendAsEmail: string, id: string): Promise<SmimeInfo>
  insert(userId: string, sendAsEmail: string, smimeInfo: SmimeInfo): Promise<SmimeInfo>
  delete(userId: string, sendAsEmail: string, id: string): Promise<void>
  setDefault(userId: string, sendAsEmail: string, id: string): Promise<void>
}

export function gmailSmimeInfoResource(http: GoogleHttp): GmailSmimeInfoResource {
  return {
    list(userId, sendAsEmail) {
      return http.json<ListSmimeInfoResponse>("gmail", "GET", collectionPath(userId, sendAsEmail))
    },
    get(userId, sendAsEmail, id) {
      return http.json<SmimeInfo>("gmail", "GET", resourcePath(userId, sendAsEmail, id))
    },
    insert(userId, sendAsEmail, smimeInfo) {
      return http.json<SmimeInfo>("gmail", "POST", collectionPath(userId, sendAsEmail), {
        body: smimeInfo,
      })
    },
    delete(userId, sendAsEmail, id) {
      return http.json<void>("gmail", "DELETE", resourcePath(userId, sendAsEmail, id))
    },
    setDefault(userId, sendAsEmail, id) {
      return http.json<void>("gmail", "POST", resourcePath(userId, sendAsEmail, id, "/setDefault"))
    },
  }
}
