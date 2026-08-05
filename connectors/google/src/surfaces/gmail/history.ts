import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type { History, HistoryListOptions, ListHistoryResponse } from "../../types/gmail"
import { gmailCollectionPath } from "./paths"

export interface GmailHistoryResource {
  /** One page of mailbox history; `startHistoryId` is required by Gmail. */
  list(userId: string, options: HistoryListOptions): Promise<ListHistoryResponse>
  /**
   * Iterate every history record. Call `list` directly when the final
   * response's current `historyId` must be persisted as a checkpoint.
   */
  listAll(userId: string, options: HistoryListOptions): AsyncIterable<History>
}

export function gmailHistoryResource(http: GoogleHttp): GmailHistoryResource {
  const resource: GmailHistoryResource = {
    list(userId, options) {
      return http.json<ListHistoryResponse>(
        "gmail",
        "GET",
        gmailCollectionPath(userId, "history"),
        { query: options }
      )
    },
    listAll(userId, options) {
      return listAllPages<ListHistoryResponse, History>(
        (pageToken) => resource.list(userId, { ...options, pageToken }),
        (page) => page.history,
        options.pageToken
      )
    },
  }

  return resource
}
