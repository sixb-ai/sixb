import type { UnipileHttp } from "../http"
import { listAllCursor } from "../pagination"
import type {
  UnipileChat,
  UnipileChatListOptions,
  UnipileChatStarted,
  UnipileChatsResponse,
  UnipileStartChatInput,
} from "../types"
import { assertLimit, assertNonEmpty, assertStringArray, pathId } from "../validation"

export interface ChatsResource {
  /** `GET /chats` */
  list(options?: UnipileChatListOptions): Promise<UnipileChatsResponse>
  /** Cursor iterator over `GET /chats`. */
  listAll(options?: UnipileChatListOptions): AsyncIterable<UnipileChat>
  /** `GET /chats/{chatId}` */
  get(chatId: string): Promise<UnipileChat>
  /** `POST /chats` — text-only, existing relations in phase 1. */
  start(input: UnipileStartChatInput): Promise<UnipileChatStarted>
}

export function createChatsResource(http: UnipileHttp): ChatsResource {
  const resource: ChatsResource = {
    list(options) {
      assertLimit(options?.limit)
      return http.get(
        "chats",
        {
          limit: options?.limit,
          cursor: options?.cursor,
          before: options?.before,
          after: options?.after,
          account_type: options?.account_type,
          account_id: options?.account_id,
          unread: options?.unread,
        },
        true
      )
    },
    listAll(options) {
      return listAllCursor(resource.list, options)
    },
    get(chatId) {
      return http.get(`chats/${pathId(chatId, "chat id")}`, undefined, true)
    },
    start(input) {
      assertNonEmpty(input.account_id, "account_id")
      assertNonEmpty(input.text, "text")
      assertStringArray(input.attendees_ids, "attendees_ids")

      const body = new FormData()
      body.append("account_id", input.account_id)
      body.append("text", input.text)
      for (const attendeeId of input.attendees_ids) {
        body.append("attendees_ids", attendeeId)
      }
      return http.post("chats", body)
    },
  }

  return resource
}
