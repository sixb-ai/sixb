import type { GoogleHttp } from "../../http"
import { listAllPages } from "../../pagination"
import type {
  BatchDeleteMessagesRequest,
  BatchModifyMessagesRequest,
  ListMessagesResponse,
  Message,
  MessageGetOptions,
  MessageImportOptions,
  MessageInsertOptions,
  MessagesListOptions,
  ModifyMessageRequest,
} from "../../types/gmail"
import { type GmailAttachmentsResource, gmailAttachmentsResource } from "./attachments"
import { gmailCollectionPath, gmailResourcePath } from "./paths"

export interface GmailMessagesResource {
  readonly attachments: GmailAttachmentsResource
  /** `GET /users/{userId}/messages` — one page of message references. */
  list(userId: string, options?: MessagesListOptions): Promise<ListMessagesResponse>
  /** Iterate every message reference across all pages. */
  listAll(userId: string, options?: MessagesListOptions): AsyncIterable<Message>
  /** `GET /users/{userId}/messages/{id}`. */
  get(userId: string, id: string, options?: MessageGetOptions): Promise<Message>
  /** `POST /users/{userId}/messages` — insert without normal SMTP scanning. */
  insert(userId: string, message: Message, options?: MessageInsertOptions): Promise<Message>
  /** `POST /users/{userId}/messages/import` — import with normal delivery scanning. */
  import(userId: string, message: Message, options?: MessageImportOptions): Promise<Message>
  /** `POST /users/{userId}/messages/send`. */
  send(userId: string, message: Message): Promise<Message>
  /** `POST /users/{userId}/messages/{id}/modify`. */
  modify(userId: string, id: string, request: ModifyMessageRequest): Promise<Message>
  /** `POST /users/{userId}/messages/batchModify`. */
  batchModify(userId: string, request: BatchModifyMessagesRequest): Promise<void>
  /** `POST /users/{userId}/messages/batchDelete`. */
  batchDelete(userId: string, request: BatchDeleteMessagesRequest): Promise<void>
  /** `DELETE /users/{userId}/messages/{id}` — permanent. */
  delete(userId: string, id: string): Promise<void>
  /** `POST /users/{userId}/messages/{id}/trash`. */
  trash(userId: string, id: string): Promise<Message>
  /** `POST /users/{userId}/messages/{id}/untrash`. */
  untrash(userId: string, id: string): Promise<Message>
}

export function gmailMessagesResource(http: GoogleHttp): GmailMessagesResource {
  const resource: GmailMessagesResource = {
    attachments: gmailAttachmentsResource(http),
    list(userId, options) {
      return http.json<ListMessagesResponse>(
        "gmail",
        "GET",
        gmailCollectionPath(userId, "messages"),
        { query: options }
      )
    },
    listAll(userId, options) {
      return listAllPages<ListMessagesResponse, Message>(
        (pageToken) => resource.list(userId, { ...options, pageToken }),
        (page) => page.messages,
        options?.pageToken
      )
    },
    get(userId, id, options) {
      return http.json<Message>(
        "gmail",
        "GET",
        gmailResourcePath(userId, "messages", id, "messageId"),
        { query: options }
      )
    },
    insert(userId, message, options) {
      return http.json<Message>("gmail", "POST", gmailCollectionPath(userId, "messages"), {
        query: options,
        body: message,
      })
    },
    import(userId, message, options) {
      return http.json<Message>(
        "gmail",
        "POST",
        gmailCollectionPath(userId, "messages", "/import"),
        { query: options, body: message }
      )
    },
    send(userId, message) {
      return http.json<Message>("gmail", "POST", gmailCollectionPath(userId, "messages", "/send"), {
        body: message,
      })
    },
    modify(userId, id, request) {
      return http.json<Message>(
        "gmail",
        "POST",
        gmailResourcePath(userId, "messages", id, "messageId", "/modify"),
        { body: request }
      )
    },
    batchModify(userId, request) {
      return http.json<void>(
        "gmail",
        "POST",
        gmailCollectionPath(userId, "messages", "/batchModify"),
        { body: request }
      )
    },
    batchDelete(userId, request) {
      return http.json<void>(
        "gmail",
        "POST",
        gmailCollectionPath(userId, "messages", "/batchDelete"),
        { body: request }
      )
    },
    delete(userId, id) {
      return http.json<void>(
        "gmail",
        "DELETE",
        gmailResourcePath(userId, "messages", id, "messageId")
      )
    },
    trash(userId, id) {
      return http.json<Message>(
        "gmail",
        "POST",
        gmailResourcePath(userId, "messages", id, "messageId", "/trash")
      )
    },
    untrash(userId, id) {
      return http.json<Message>(
        "gmail",
        "POST",
        gmailResourcePath(userId, "messages", id, "messageId", "/untrash")
      )
    },
  }

  return resource
}
