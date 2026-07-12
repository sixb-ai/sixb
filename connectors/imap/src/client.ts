import { Readable } from "node:stream"
import {
  type DownloadObject,
  type FetchMessageObject,
  type FetchOptions,
  type FetchQueryObject,
  ImapFlow,
  type ImapFlowOptions,
  type ListOptions,
  type ListResponse,
  type MailboxLockObject,
  type MailboxObject,
  type MessageAddressObject,
  type MessageEnvelopeObject,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow"
import {
  ImapAbortedError,
  ImapConnectorError,
  ImapDownloadTooLargeError,
  ImapPartUnavailableError,
  imapOperationError,
} from "./errors"
import type {
  ImapAddress,
  ImapBodyPart,
  ImapClient,
  ImapConnection,
  ImapDownloadedPart,
  ImapDownloadInput,
  ImapEnvelope,
  ImapHeaders,
  ImapListMessagesInput,
  ImapMailboxInfo,
  ImapMailboxSession,
  ImapMailboxState,
  ImapMessageSummary,
  ImapOperationOptions,
} from "./types"

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000
const DEFAULT_SOCKET_TIMEOUT_MS = 300_000
const MAX_PAGE_SIZE = 1_000
const MAX_REQUESTED_HEADERS = 64
const MAX_HEADER_NAME_LENGTH = 128
const MAX_UID = 0xffff_ffff
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export interface ImapTransport {
  usable: boolean
  mailbox: MailboxObject | false
  connect(): Promise<void>
  logout(): Promise<void>
  close(): void
  list(options?: ListOptions): Promise<ListResponse[]>
  getMailboxLock(
    path: string | string[],
    options?: { readOnly?: boolean }
  ): Promise<MailboxLockObject>
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false>
  fetchAll(
    range: string | number[] | SearchObject,
    query: FetchQueryObject,
    options?: FetchOptions
  ): Promise<FetchMessageObject[]>
  download(
    range: string | number | bigint,
    part?: string,
    options?: { uid?: boolean; maxBytes?: number; chunkSize?: number }
  ): Promise<Partial<DownloadObject>>
}

export type ImapTransportFactory = (options: ImapFlowOptions) => ImapTransport

const defaultTransportFactory: ImapTransportFactory = (options) => new ImapFlow(options)

export function createImapClient(
  connection: ImapConnection,
  lifecycleSignal: AbortSignal,
  transportFactory: ImapTransportFactory = defaultTransportFactory
): ImapClient {
  return new ImapGateway(connection, lifecycleSignal, transportFactory)
}

class ImapGateway implements ImapClient {
  private readonly activeTransports = new Set<ImapTransport>()
  private readonly flowOptions: ImapFlowOptions
  private closed = false

  constructor(
    private readonly connection: ImapConnection,
    private readonly lifecycleSignal: AbortSignal,
    private readonly transportFactory: ImapTransportFactory
  ) {
    this.flowOptions = toImapFlowOptions(connection)
    this.lifecycleSignal.addEventListener("abort", this.handleLifecycleAbort, { once: true })
  }

  async listMailboxes(options: ImapOperationOptions = {}): Promise<readonly ImapMailboxInfo[]> {
    return this.runOperation(options.signal, async (transport) => {
      try {
        const mailboxes = await transport.list({
          statusQuery: {
            messages: true,
            recent: true,
            uidNext: true,
            uidValidity: true,
            unseen: true,
            highestModseq: true,
          },
        })
        return mailboxes.map(normalizeMailboxInfo)
      } catch (error) {
        throw imapOperationError("Mailbox listing", error, [this.connection.auth.pass])
      }
    })
  }

  async withMailbox<T>(
    path: string,
    task: (mailbox: ImapMailboxSession) => Promise<T>,
    options: ImapOperationOptions = {}
  ): Promise<T> {
    const normalizedPath = path.trim()
    if (!normalizedPath) {
      throw new ImapConnectorError("Mailbox path must not be empty.")
    }

    return this.runOperation(options.signal, async (transport) => {
      let lock: MailboxLockObject | undefined
      let session: ImapMailboxSessionImpl | undefined

      try {
        lock = await transport.getMailboxLock(normalizedPath, { readOnly: true })
        if (!transport.mailbox) {
          throw new ImapConnectorError(`Mailbox ${normalizedPath} did not open.`)
        }
        if (!transport.mailbox.readOnly) {
          throw new ImapConnectorError(`Mailbox ${normalizedPath} was not opened read-only.`)
        }

        session = new ImapMailboxSessionImpl(transport, this.connection.auth.pass)
        return await task(session)
      } catch (error) {
        if (error instanceof ImapConnectorError || session) {
          throw error
        }
        throw imapOperationError("Mailbox open", error, [this.connection.auth.pass])
      } finally {
        session?.deactivate()
        lock?.release()
      }
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    this.lifecycleSignal.removeEventListener("abort", this.handleLifecycleAbort)
    for (const transport of this.activeTransports) {
      transport.close()
    }
    this.activeTransports.clear()
  }

  private readonly handleLifecycleAbort = () => {
    void this.close()
  }

  private async runOperation<T>(
    operationSignal: AbortSignal | undefined,
    task: (transport: ImapTransport) => Promise<T>
  ): Promise<T> {
    this.assertAvailable(operationSignal)

    let transport: ImapTransport
    try {
      transport = this.transportFactory(this.flowOptions)
    } catch (error) {
      throw imapOperationError("Client creation", error, [this.connection.auth.pass])
    }

    this.activeTransports.add(transport)
    const abort = () => transport.close()
    this.lifecycleSignal.addEventListener("abort", abort, { once: true })
    operationSignal?.addEventListener("abort", abort, { once: true })

    let value: T | undefined
    let failure: unknown
    let phase: "connect" | "task" = "connect"

    try {
      await transport.connect()
      this.assertAvailable(operationSignal)
      phase = "task"
      value = await task(transport)
      this.assertAvailable(operationSignal)
    } catch (error) {
      if (this.isAborted(operationSignal)) {
        failure = new ImapAbortedError()
      } else if (phase === "connect") {
        failure = imapOperationError("Connection", error, [this.connection.auth.pass])
      } else {
        failure = error
      }
    }

    let cleanupFailure: unknown
    try {
      if (transport.usable) {
        await transport.logout()
      } else {
        transport.close()
      }
    } catch (error) {
      transport.close()
      cleanupFailure = imapOperationError("Connection cleanup", error, [this.connection.auth.pass])
    } finally {
      this.lifecycleSignal.removeEventListener("abort", abort)
      operationSignal?.removeEventListener("abort", abort)
      this.activeTransports.delete(transport)
    }

    if (failure) {
      throw failure
    }
    if (cleanupFailure) {
      throw cleanupFailure
    }
    return value as T
  }

  private assertAvailable(operationSignal?: AbortSignal): void {
    if (this.isAborted(operationSignal)) {
      throw new ImapAbortedError()
    }
  }

  private isAborted(operationSignal?: AbortSignal): boolean {
    return this.closed || this.lifecycleSignal.aborted || operationSignal?.aborted === true
  }
}

class ImapMailboxSessionImpl implements ImapMailboxSession {
  private readonly activeStreams = new Map<Readable, Readable>()
  private active = true

  constructor(
    private readonly transport: ImapTransport,
    private readonly password: string
  ) {}

  state(): ImapMailboxState {
    const mailbox = this.currentMailbox()
    return {
      path: mailbox.path,
      uidValidity: mailbox.uidValidity,
      uidNext: mailbox.uidNext,
      exists: mailbox.exists,
      readOnly: true,
    }
  }

  async listMessages(input: ImapListMessagesInput): Promise<readonly ImapMessageSummary[]> {
    this.assertActive()
    const requestedHeaders = validateListInput(input)
    const fetchHeaders = [...new Set(["references", ...requestedHeaders])]

    const startUid = (input.afterUid ?? 0) + 1
    const search: SearchObject = {
      uid: `${startUid}:*`,
      ...(input.since ? { since: input.since } : {}),
    }

    try {
      const searchResult = await this.transport.search(search, { uid: true })
      this.assertActive()
      if (!searchResult || searchResult.length === 0) {
        return []
      }

      const uids = [...searchResult]
        .filter((uid) => uid >= startUid)
        .sort((left, right) => left - right)
        .slice(0, input.limit)

      if (uids.length === 0) {
        return []
      }

      const messages = await this.transport.fetchAll(
        uids,
        {
          uid: true,
          envelope: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
          headers: fetchHeaders,
        },
        { uid: true }
      )
      this.assertActive()
      return messages
        .map((message) => normalizeMessage(message, requestedHeaders))
        .sort((left, right) => left.uid - right.uid)
    } catch (error) {
      throw imapOperationError("Message listing", error, [this.password])
    }
  }

  async downloadPart(input: ImapDownloadInput): Promise<ImapDownloadedPart> {
    this.assertActive()
    validateDownloadInput(input)

    let downloaded: Partial<DownloadObject>
    try {
      downloaded = await this.transport.download(input.uid, input.part, {
        uid: true,
        maxBytes: input.maxBytes + 1,
      })
      this.assertActive()
    } catch (error) {
      throw imapOperationError("Message part download", error, [this.password])
    }

    // ImapFlow resolves an empty object (no `meta`/`content`) when the mailbox is no
    // longer selected or the requested body part is absent from the server response.
    // Surface that as a typed, actionable error before it poisons `activeStreams`.
    if (!downloaded.content || !downloaded.meta) {
      throw new ImapPartUnavailableError(input.uid, input.part)
    }

    const content = limitReadable(downloaded.content, input)
    this.activeStreams.set(content, downloaded.content)
    content.once("close", () => {
      const source = this.activeStreams.get(content)
      this.activeStreams.delete(content)
      if (source && !source.destroyed) {
        source.destroy()
      }
    })

    return {
      meta: {
        expectedSize: downloaded.meta.expectedSize,
        contentType: downloaded.meta.contentType,
        charset: downloaded.meta.charset ?? null,
        disposition: downloaded.meta.disposition ?? null,
        filename: downloaded.meta.filename ?? null,
        encoding: downloaded.meta.encoding ?? null,
      },
      content,
    }
  }

  deactivate(): void {
    if (!this.active) {
      return
    }
    this.active = false
    // Cleanup runs inside withMailbox's `finally`, so a throw here would mask the real
    // operation error. Guard every stream (undefined source, already destroyed) so
    // teardown always completes.
    for (const [content, source] of this.activeStreams) {
      if (!content.destroyed) {
        content.destroy()
      }
      if (source && !source.destroyed) {
        source.destroy()
      }
    }
    this.activeStreams.clear()
  }

  private assertActive(): void {
    if (!this.active) {
      throw new ImapConnectorError("Mailbox session is no longer active.")
    }
  }

  private currentMailbox(): MailboxObject {
    this.assertActive()
    if (!this.transport.mailbox) {
      throw new ImapConnectorError("No mailbox is open.")
    }
    return this.transport.mailbox
  }
}

function toImapFlowOptions(connection: ImapConnection): ImapFlowOptions {
  return {
    host: connection.host,
    port: connection.port ?? 993,
    secure: true,
    servername: connection.tls?.servername ?? connection.host,
    auth: {
      user: connection.auth.user,
      pass: connection.auth.pass,
    },
    tls: {
      rejectUnauthorized: connection.tls?.rejectUnauthorized ?? true,
    },
    logger: false,
    logRaw: false,
    emitLogs: false,
    disableAutoIdle: true,
    connectionTimeout: connection.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    socketTimeout: connection.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
  }
}

function normalizeMailboxInfo(mailbox: ListResponse): ImapMailboxInfo {
  return {
    path: mailbox.path,
    name: mailbox.name,
    delimiter: mailbox.delimiter,
    parentPath: mailbox.parentPath,
    flags: [...mailbox.flags].sort(),
    specialUse: mailbox.specialUse ?? null,
    listed: mailbox.listed,
    subscribed: mailbox.subscribed,
    status: mailbox.status
      ? {
          messages: mailbox.status.messages ?? null,
          recent: mailbox.status.recent ?? null,
          uidNext: mailbox.status.uidNext ?? null,
          uidValidity: mailbox.status.uidValidity ?? null,
          unseen: mailbox.status.unseen ?? null,
          highestModseq: mailbox.status.highestModseq ?? null,
        }
      : null,
  }
}

function normalizeMessage(
  message: FetchMessageObject,
  requestedHeaders: readonly string[]
): ImapMessageSummary {
  const parsedHeaders = parseHeaders(message.headers)
  return {
    seq: message.seq,
    uid: message.uid,
    internalDate: normalizeDate(message.internalDate),
    size: message.size ?? null,
    envelope: message.envelope ? normalizeEnvelope(message.envelope) : null,
    headers: selectHeaders(parsedHeaders, requestedHeaders),
    references: parseReferences(parsedHeaders),
    bodyStructure: message.bodyStructure ? normalizeBodyPart(message.bodyStructure) : null,
  }
}

function normalizeEnvelope(envelope: MessageEnvelopeObject): ImapEnvelope {
  return {
    date: envelope.date ?? null,
    subject: envelope.subject ?? null,
    messageId: normalizeOptionalString(envelope.messageId),
    inReplyTo: normalizeOptionalString(envelope.inReplyTo),
    from: normalizeAddresses(envelope.from),
    sender: normalizeAddresses(envelope.sender),
    replyTo: normalizeAddresses(envelope.replyTo),
    to: normalizeAddresses(envelope.to),
    cc: normalizeAddresses(envelope.cc),
    bcc: normalizeAddresses(envelope.bcc),
  }
}

function normalizeAddresses(addresses?: MessageAddressObject[]): readonly ImapAddress[] {
  return (addresses ?? []).map((address) => ({
    name: normalizeOptionalString(address.name),
    address: normalizeOptionalString(address.address),
  }))
}

function normalizeBodyPart(part: MessageStructureObject): ImapBodyPart {
  return {
    part: part.part ?? null,
    type: part.type,
    parameters: { ...(part.parameters ?? {}) },
    id: normalizeOptionalString(part.id),
    encoding: normalizeOptionalString(part.encoding),
    size: part.size ?? null,
    disposition: normalizeOptionalString(part.disposition),
    dispositionParameters: { ...(part.dispositionParameters ?? {}) },
    childNodes: (part.childNodes ?? []).map(normalizeBodyPart),
  }
}

function normalizeDate(value: Date | string | undefined): Date | null {
  if (!value) {
    return null
  }
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function normalizeOptionalString(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function parseHeaders(headers: Buffer | undefined): ImapHeaders {
  const result = new Map<string, string[]>()
  if (!headers?.length) {
    return Object.fromEntries(result)
  }

  const unfolded = headers.toString("utf8").replaceAll(/\r?\n[\t ]+/g, " ")

  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator < 1) {
      continue
    }
    const name = line.slice(0, separator).trim().toLowerCase()
    if (!HEADER_NAME_PATTERN.test(name)) {
      continue
    }
    const value = line.slice(separator + 1).trim()
    const values = result.get(name)
    if (values) {
      values.push(value)
    } else {
      result.set(name, [value])
    }
  }

  return Object.fromEntries(result)
}

function selectHeaders(headers: ImapHeaders, requestedHeaders: readonly string[]): ImapHeaders {
  return Object.fromEntries(
    requestedHeaders.flatMap((name) => {
      const values = headers[name]
      return values ? [[name, values] as const] : []
    })
  )
}

function parseReferences(headers: ImapHeaders): readonly string[] {
  const references: string[] = []

  for (const value of headers.references ?? []) {
    const messageIds = value.match(/<[^<>]+>/g) ?? value.split(/\s+/).filter(Boolean)
    references.push(...messageIds)
  }

  return [...new Set(references)]
}

function validateListInput(input: ImapListMessagesInput): readonly string[] {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
    throw new ImapConnectorError(`Message page limit must be between 1 and ${MAX_PAGE_SIZE}.`)
  }
  if (
    input.afterUid !== undefined &&
    (!Number.isInteger(input.afterUid) || input.afterUid < 0 || input.afterUid >= MAX_UID)
  ) {
    throw new ImapConnectorError(`afterUid must be an integer between 0 and ${MAX_UID - 1}.`)
  }
  if (input.since && Number.isNaN(input.since.getTime())) {
    throw new ImapConnectorError("since must be a valid Date.")
  }
  return normalizeRequestedHeaders(input.headers)
}

function normalizeRequestedHeaders(headers: readonly string[] | undefined): readonly string[] {
  if (!headers) {
    return []
  }
  if (headers.length > MAX_REQUESTED_HEADERS) {
    throw new ImapConnectorError(
      `No more than ${MAX_REQUESTED_HEADERS} message headers may be requested.`
    )
  }

  const normalized: string[] = []
  const seen = new Set<string>()
  for (const header of headers) {
    if (typeof header !== "string") {
      throw new ImapConnectorError("Message header names must be strings.")
    }
    const name = header.trim().toLowerCase()
    if (!name || name.length > MAX_HEADER_NAME_LENGTH || !HEADER_NAME_PATTERN.test(name)) {
      throw new ImapConnectorError("Message header names must be valid RFC 5322 field names.")
    }
    if (!seen.has(name)) {
      normalized.push(name)
      seen.add(name)
    }
  }
  return normalized
}

function validateDownloadInput(input: ImapDownloadInput): void {
  if (!Number.isInteger(input.uid) || input.uid < 1 || input.uid > MAX_UID) {
    throw new ImapConnectorError(`Message UID must be an integer between 1 and ${MAX_UID}.`)
  }
  if (!input.part.trim()) {
    throw new ImapConnectorError("Message part must not be empty.")
  }
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 1 ||
    input.maxBytes >= Number.MAX_SAFE_INTEGER
  ) {
    throw new ImapConnectorError("maxBytes must be a positive safe integer.")
  }
}

function limitReadable(source: Readable, input: ImapDownloadInput): Readable {
  return Readable.from(
    (async function* () {
      let received = 0
      try {
        for await (const value of source) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          received += chunk.byteLength
          if (received > input.maxBytes) {
            throw new ImapDownloadTooLargeError(input.uid, input.part, input.maxBytes)
          }
          yield chunk
        }
      } finally {
        if (!source.destroyed) {
          source.destroy()
        }
      }
    })()
  )
}
