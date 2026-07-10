import type { Readable } from "node:stream"
import type { ConnectorAdapter } from "@sixb/core"

export interface ImapConnection {
  readonly host: string
  readonly port?: number
  readonly auth: {
    readonly user: string
    readonly pass: string
  }
  readonly tls?: {
    readonly rejectUnauthorized?: boolean
    readonly servername?: string
  }
  readonly connectTimeoutMs?: number
  readonly socketTimeoutMs?: number
}

export interface ImapOperationOptions {
  readonly signal?: AbortSignal
}

export interface ImapMailboxStatus {
  readonly messages: number | null
  readonly recent: number | null
  readonly uidNext: number | null
  readonly uidValidity: bigint | null
  readonly unseen: number | null
  readonly highestModseq: bigint | null
}

export interface ImapMailboxInfo {
  readonly path: string
  readonly name: string
  readonly delimiter: string
  readonly parentPath: string
  readonly flags: readonly string[]
  readonly specialUse: string | null
  readonly listed: boolean
  readonly subscribed: boolean
  readonly status: ImapMailboxStatus | null
}

export interface ImapMailboxState {
  readonly path: string
  readonly uidValidity: bigint
  readonly uidNext: number
  readonly exists: number
  readonly readOnly: true
}

export interface ImapAddress {
  readonly name: string | null
  readonly address: string | null
}

export interface ImapEnvelope {
  readonly date: Date | null
  readonly subject: string | null
  readonly messageId: string | null
  readonly inReplyTo: string | null
  readonly from: readonly ImapAddress[]
  readonly sender: readonly ImapAddress[]
  readonly replyTo: readonly ImapAddress[]
  readonly to: readonly ImapAddress[]
  readonly cc: readonly ImapAddress[]
  readonly bcc: readonly ImapAddress[]
}

export interface ImapBodyPart {
  readonly part: string | null
  readonly type: string
  readonly parameters: Readonly<Record<string, string>>
  readonly id: string | null
  readonly encoding: string | null
  readonly size: number | null
  readonly disposition: string | null
  readonly dispositionParameters: Readonly<Record<string, string>>
  readonly childNodes: readonly ImapBodyPart[]
}

export interface ImapMessageSummary {
  readonly seq: number
  readonly uid: number
  readonly internalDate: Date | null
  readonly size: number | null
  readonly envelope: ImapEnvelope | null
  readonly references: readonly string[]
  readonly bodyStructure: ImapBodyPart | null
}

export interface ImapListMessagesInput {
  /** Exclusive UID checkpoint. Omit to start from the first message. */
  readonly afterUid?: number
  /** Optional server-side IMAP SINCE filter, based on the internal date. */
  readonly since?: Date
  /** Maximum page size, from 1 to 1000. */
  readonly limit: number
}

export interface ImapDownloadInput {
  readonly uid: number
  readonly part: string
  readonly maxBytes: number
}

export interface ImapDownloadedPart {
  readonly meta: {
    /** ImapFlow's server-reported size; it may describe the full message, not this MIME part. */
    readonly expectedSize: number
    readonly contentType: string
    readonly charset: string | null
    readonly disposition: string | null
    readonly filename: string | null
    readonly encoding: string | null
  }
  readonly content: Readable
}

export interface ImapMailboxSession {
  state(): ImapMailboxState
  listMessages(input: ImapListMessagesInput): Promise<readonly ImapMessageSummary[]>
  downloadPart(input: ImapDownloadInput): Promise<ImapDownloadedPart>
}

export interface ImapClient {
  listMailboxes(options?: ImapOperationOptions): Promise<readonly ImapMailboxInfo[]>
  withMailbox<T>(
    path: string,
    task: (mailbox: ImapMailboxSession) => Promise<T>,
    options?: ImapOperationOptions
  ): Promise<T>
  close(): Promise<void>
}

export type ImapConnector = ConnectorAdapter<"imap", ImapClient>
