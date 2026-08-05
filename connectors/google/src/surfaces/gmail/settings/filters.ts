import type { GoogleHttp } from "../../../http"
import type { Filter, ListFiltersResponse } from "../../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "../paths"

const COLLECTION = "settings/filters"

export interface GmailFiltersResource {
  list(userId: string): Promise<ListFiltersResponse>
  get(userId: string, id: string): Promise<Filter>
  create(userId: string, filter: Filter): Promise<Filter>
  delete(userId: string, id: string): Promise<void>
}

export function gmailFiltersResource(http: GoogleHttp): GmailFiltersResource {
  return {
    list(userId) {
      return http.json<ListFiltersResponse>("gmail", "GET", gmailCollectionPath(userId, COLLECTION))
    },
    get(userId, id) {
      return http.json<Filter>(
        "gmail",
        "GET",
        gmailResourcePath(userId, COLLECTION, id, "filterId")
      )
    },
    create(userId, filter) {
      return http.json<Filter>("gmail", "POST", gmailCollectionPath(userId, COLLECTION), {
        body: filter,
      })
    },
    delete(userId, id) {
      return http.json<void>(
        "gmail",
        "DELETE",
        gmailResourcePath(userId, COLLECTION, id, "filterId")
      )
    },
  }
}
