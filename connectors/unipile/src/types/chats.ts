import type {
  UnipileCursorOptions,
  UnipileCursorPage,
  UnipileMessagingProvider,
  UnipileTimestamp,
} from "./common"
import type { UnipileMessage } from "./messages"

export type UnipileChatType = 0 | 1 | 2

export type UnipileChatFolder =
  | "INBOX"
  | "INBOX_LINKEDIN_CLASSIC"
  | "INBOX_LINKEDIN_RECRUITER"
  | "INBOX_LINKEDIN_SALES_NAVIGATOR"
  | "INBOX_LINKEDIN_ORGANIZATION"
  | (string & {})

export interface UnipileChat {
  readonly object: "Chat"
  readonly id: string
  readonly account_id: string
  readonly account_type: UnipileMessagingProvider
  readonly provider_id: string
  readonly attendee_provider_id?: string
  readonly name: string | null
  readonly type: UnipileChatType
  readonly timestamp: UnipileTimestamp | null
  readonly unread_count: number
  readonly archived: 0 | 1
  readonly muted_until: -1 | string | null
  readonly read_only: 0 | 1 | 2
  readonly disabledFeatures?: readonly ("reactions" | "reply" | (string & {}))[]
  readonly subject?: string
  readonly folder?: readonly UnipileChatFolder[]
  readonly lastMessage?: UnipileMessage | null
  readonly [key: string]: unknown
}

export interface UnipileChatListOptions extends UnipileCursorOptions {
  readonly before?: UnipileTimestamp
  readonly after?: UnipileTimestamp
  readonly account_type?: UnipileMessagingProvider
  readonly account_id?: string | readonly string[]
  readonly unread?: boolean
}

export type UnipileChatsResponse = UnipileCursorPage<UnipileChat>

/** Phase 1 starts a text chat with existing relations only. */
export interface UnipileStartChatInput {
  readonly account_id: string
  readonly attendees_ids: readonly string[]
  readonly text: string
}

export interface UnipileChatStarted {
  readonly object: "ChatStarted"
  readonly chat_id: string | null
  readonly message_id: string | null
}
