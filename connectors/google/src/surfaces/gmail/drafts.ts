import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  Draft,
  DraftGetOptions,
  DraftsListOptions,
  ListDraftsResponse,
  Message,
} from "../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "./paths"

export interface GmailDraftsResource {
  list(userId: string, options?: DraftsListOptions): Promise<ListDraftsResponse>
  listAll(userId: string, options?: DraftsListOptions): AsyncIterable<Draft>
  get(userId: string, id: string, options?: DraftGetOptions): Promise<Draft>
  create(userId: string, draft: Draft): Promise<Draft>
  update(userId: string, id: string, draft: Draft): Promise<Draft>
  send(userId: string, draft: Draft): Promise<Message>
  delete(userId: string, id: string): Promise<void>
}

export function gmailDraftsResource(http: GoogleHttp): GmailDraftsResource {
  const resource: GmailDraftsResource = {
    list(userId, options) {
      return http.json<ListDraftsResponse>("gmail", "GET", gmailCollectionPath(userId, "drafts"), {
        query: options,
      })
    },
    listAll(userId, options) {
      return listAllPages<ListDraftsResponse, Draft>(
        (pageToken) => resource.list(userId, { ...options, pageToken }),
        (page) => page.drafts,
        options?.pageToken
      )
    },
    get(userId, id, options) {
      return http.json<Draft>("gmail", "GET", gmailResourcePath(userId, "drafts", id, "draftId"), {
        query: options,
      })
    },
    create(userId, draft) {
      return http.json<Draft>("gmail", "POST", gmailCollectionPath(userId, "drafts"), {
        body: draft,
      })
    },
    update(userId, id, draft) {
      return http.json<Draft>("gmail", "PUT", gmailResourcePath(userId, "drafts", id, "draftId"), {
        body: draft,
      })
    },
    send(userId, draft) {
      return http.json<Message>("gmail", "POST", gmailCollectionPath(userId, "drafts", "/send"), {
        body: draft,
      })
    },
    delete(userId, id) {
      return http.json<void>("gmail", "DELETE", gmailResourcePath(userId, "drafts", id, "draftId"))
    },
  }

  return resource
}
