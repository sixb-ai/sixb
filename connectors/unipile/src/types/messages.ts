import type {
  UnipileBoolean,
  UnipileCursorOptions,
  UnipileCursorPage,
  UnipileTimestamp,
} from "./common"

export interface UnipileAttachmentSize {
  readonly width: number | string
  readonly height: number | string
}

export interface UnipileMessageAttachment {
  readonly id: string
  readonly type: "img" | "video" | "audio" | "file" | "linkedin_post" | (string & {})
  readonly unavailable: boolean
  readonly mimetype?: string
  readonly url?: string
  readonly file_size?: number
  readonly file_name?: string
  readonly size?: UnipileAttachmentSize
  readonly sticker?: boolean
  readonly gif?: boolean
  readonly duration?: number
  readonly voice_note?: boolean
  readonly [key: string]: unknown
}

export interface UnipileMessageReaction {
  readonly value: string
  readonly sender_id: string
  readonly is_sender: boolean
}

export type UnipileMessageSubtype =
  | "MESSAGE"
  | "INVITATION"
  | "INMAIL"
  | "INMAIL_DECLINE"
  | "INMAIL_REPLY"
  | "INMAIL_ACCEPT"
  | (string & {})

export interface UnipileQuotedMessage {
  readonly provider_id: string
  readonly sender_id: string
  readonly text: string | null
  readonly attachments: readonly UnipileMessageAttachment[]
}

export interface UnipileMessage {
  readonly object: "Message"
  readonly id: string
  readonly account_id: string
  readonly chat_id: string
  readonly provider_id: string
  readonly chat_provider_id: string
  readonly sender_id: string
  readonly sender_attendee_id?: string
  readonly text: string | null
  readonly timestamp: UnipileTimestamp
  readonly is_sender: UnipileBoolean
  readonly attachments: readonly UnipileMessageAttachment[]
  readonly reactions: readonly UnipileMessageReaction[]
  readonly seen: UnipileBoolean
  readonly seen_by: Readonly<Record<string, string | boolean>>
  readonly delivered: UnipileBoolean
  readonly hidden: UnipileBoolean
  readonly deleted: UnipileBoolean
  readonly edited: UnipileBoolean
  readonly is_event: UnipileBoolean
  readonly event_type?: number
  readonly message_type?: UnipileMessageSubtype | null
  readonly quoted?: UnipileQuotedMessage | null
  readonly original?: string
  readonly [key: string]: unknown
}

export interface UnipileMessageListOptions extends UnipileCursorOptions {
  readonly before?: UnipileTimestamp
  readonly after?: UnipileTimestamp
  readonly sender_id?: string
}

export type UnipileMessagesResponse = UnipileCursorPage<UnipileMessage>

/** Phase 1 deliberately supports text-only messages. */
export interface UnipileSendMessageInput {
  readonly text: string
  /** Prevent sending through a chat belonging to a different account. */
  readonly account_id?: string
}

export interface UnipileMessageSent {
  readonly object: "MessageSent"
  readonly message_id: string | null
}
