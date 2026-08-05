import type { GoogleHttp } from "../../../http"
import { listAllPages } from "../../../pagination"
import type { CseIdentity, CseListOptions, ListCseIdentitiesResponse } from "../../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "../paths"

const COLLECTION = "settings/cse/identities"

export interface GmailCseIdentitiesResource {
  list(userId: string, options?: CseListOptions): Promise<ListCseIdentitiesResponse>
  listAll(userId: string, options?: CseListOptions): AsyncIterable<CseIdentity>
  get(userId: string, cseEmailAddress: string): Promise<CseIdentity>
  create(userId: string, identity: CseIdentity): Promise<CseIdentity>
  patch(userId: string, emailAddress: string, identity: CseIdentity): Promise<CseIdentity>
  delete(userId: string, cseEmailAddress: string): Promise<void>
}

export function gmailCseIdentitiesResource(http: GoogleHttp): GmailCseIdentitiesResource {
  const resource: GmailCseIdentitiesResource = {
    list(userId, options) {
      return http.json<ListCseIdentitiesResponse>(
        "gmail",
        "GET",
        gmailCollectionPath(userId, COLLECTION),
        { query: options }
      )
    },
    listAll(userId, options) {
      return listAllPages<ListCseIdentitiesResponse, CseIdentity>(
        (pageToken) => resource.list(userId, { ...options, pageToken }),
        (page) => page.cseIdentities,
        options?.pageToken
      )
    },
    get(userId, cseEmailAddress) {
      return http.json<CseIdentity>(
        "gmail",
        "GET",
        gmailResourcePath(userId, COLLECTION, cseEmailAddress, "cseEmailAddress")
      )
    },
    create(userId, identity) {
      return http.json<CseIdentity>("gmail", "POST", gmailCollectionPath(userId, COLLECTION), {
        body: identity,
      })
    },
    patch(userId, emailAddress, identity) {
      return http.json<CseIdentity>(
        "gmail",
        "PATCH",
        gmailResourcePath(userId, COLLECTION, emailAddress, "emailAddress"),
        { body: identity }
      )
    },
    delete(userId, cseEmailAddress) {
      return http.json<void>(
        "gmail",
        "DELETE",
        gmailResourcePath(userId, COLLECTION, cseEmailAddress, "cseEmailAddress")
      )
    },
  }

  return resource
}
