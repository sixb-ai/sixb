import type { UnipileHttp } from "../http"
import { listAllCursor } from "../pagination"
import type {
  UnipileMessage,
  UnipileMessageListOptions,
  UnipileMessageSent,
  UnipileMessagesResponse,
  UnipileSendMessageInput,
} from "../types"
import { assertLimit, assertNonEmpty, pathId } from "../validation"

export interface MessagesResource {
  /** `GET /chats/{chatId}/messages` */
  listForChat(chatId: string, options?: UnipileMessageListOptions): Promise<UnipileMessagesResponse>
  /** Cursor iterator over `GET /chats/{chatId}/messages`. */
  listAllForChat(chatId: string, options?: UnipileMessageListOptions): AsyncIterable<UnipileMessage>
  /** `POST /chats/{chatId}/messages` — text-only in phase 1. */
  send(chatId: string, input: UnipileSendMessageInput): Promise<UnipileMessageSent>
}

export function createMessagesResource(http: UnipileHttp): MessagesResource {
  const resource: MessagesResource = {
    listForChat(chatId, options) {
      assertLimit(options?.limit)
      return http.get(
        `chats/${pathId(chatId, "chat id")}/messages`,
        {
          limit: options?.limit,
          cursor: options?.cursor,
          before: options?.before,
          after: options?.after,
          sender_id: options?.sender_id,
        },
        true
      )
    },
    listAllForChat(chatId, options) {
      const list = (pageOptions?: UnipileMessageListOptions) =>
        resource.listForChat(chatId, pageOptions)
      return listAllCursor(list, options)
    },
    send(chatId, input) {
      assertNonEmpty(chatId, "chat id")
      assertNonEmpty(input.text, "text")
      if (input.account_id !== undefined) {
        assertNonEmpty(input.account_id, "account_id")
      }

      const body = new FormData()
      body.append("text", input.text)
      if (input.account_id) {
        body.append("account_id", input.account_id)
      }
      return http.post(`chats/${pathId(chatId, "chat id")}/messages`, body)
    },
  }

  return resource
}
