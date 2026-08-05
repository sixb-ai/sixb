import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  ListThreadsResponse,
  ModifyThreadRequest,
  Thread,
  ThreadGetOptions,
  ThreadsListOptions,
} from "../../types/gmail"
import { gmailCollectionPath, gmailResourcePath } from "./paths"

export interface GmailThreadsResource {
  list(userId: string, options?: ThreadsListOptions): Promise<ListThreadsResponse>
  listAll(userId: string, options?: ThreadsListOptions): AsyncIterable<Thread>
  get(userId: string, id: string, options?: ThreadGetOptions): Promise<Thread>
  modify(userId: string, id: string, request: ModifyThreadRequest): Promise<Thread>
  delete(userId: string, id: string): Promise<void>
  trash(userId: string, id: string): Promise<Thread>
  untrash(userId: string, id: string): Promise<Thread>
}

export function gmailThreadsResource(http: GoogleHttp): GmailThreadsResource {
  const resource: GmailThreadsResource = {
    list(userId, options) {
      return http.json<ListThreadsResponse>(
        "gmail",
        "GET",
        gmailCollectionPath(userId, "threads"),
        { query: options }
      )
    },
    listAll(userId, options) {
      return listAllPages<ListThreadsResponse, Thread>(
        (pageToken) => resource.list(userId, { ...options, pageToken }),
        (page) => page.threads,
        options?.pageToken
      )
    },
    get(userId, id, options) {
      return http.json<Thread>(
        "gmail",
        "GET",
        gmailResourcePath(userId, "threads", id, "threadId"),
        { query: options }
      )
    },
    modify(userId, id, request) {
      return http.json<Thread>(
        "gmail",
        "POST",
        gmailResourcePath(userId, "threads", id, "threadId", "/modify"),
        { body: request }
      )
    },
    delete(userId, id) {
      return http.json<void>(
        "gmail",
        "DELETE",
        gmailResourcePath(userId, "threads", id, "threadId")
      )
    },
    trash(userId, id) {
      return http.json<Thread>(
        "gmail",
        "POST",
        gmailResourcePath(userId, "threads", id, "threadId", "/trash")
      )
    },
    untrash(userId, id) {
      return http.json<Thread>(
        "gmail",
        "POST",
        gmailResourcePath(userId, "threads", id, "threadId", "/untrash")
      )
    },
  }

  return resource
}
