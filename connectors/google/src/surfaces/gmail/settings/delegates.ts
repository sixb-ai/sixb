import type { GoogleHttp } from "../../../http"
import type { Delegate, ListDelegatesResponse } from "../../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "../paths"

const COLLECTION = "settings/delegates"

export interface GmailDelegatesResource {
  list(userId: string): Promise<ListDelegatesResponse>
  get(userId: string, delegateEmail: string): Promise<Delegate>
  create(userId: string, delegate: Delegate): Promise<Delegate>
  delete(userId: string, delegateEmail: string): Promise<void>
}

export function gmailDelegatesResource(http: GoogleHttp): GmailDelegatesResource {
  return {
    list(userId) {
      return http.json<ListDelegatesResponse>(
        "gmail",
        "GET",
        gmailCollectionPath(userId, COLLECTION)
      )
    },
    get(userId, delegateEmail) {
      return http.json<Delegate>(
        "gmail",
        "GET",
        gmailResourcePath(userId, COLLECTION, delegateEmail, "delegateEmail")
      )
    },
    create(userId, delegate) {
      return http.json<Delegate>("gmail", "POST", gmailCollectionPath(userId, COLLECTION), {
        body: delegate,
      })
    },
    delete(userId, delegateEmail) {
      return http.json<void>(
        "gmail",
        "DELETE",
        gmailResourcePath(userId, COLLECTION, delegateEmail, "delegateEmail")
      )
    },
  }
}
