import { describe, expect, test } from "bun:test"
import { Readable } from "node:stream"
import type {
  DownloadObject,
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ImapFlowOptions,
  ListOptions,
  ListResponse,
  MailboxLockObject,
  MailboxObject,
  SearchObject,
} from "imapflow"
import {
  ImapAbortedError,
  ImapConnectorError,
  ImapDownloadTooLargeError,
  ImapPartUnavailableError,
  imap,
} from "../src"
import { createImapClient, type ImapTransport } from "../src/client"
import type { ImapConnection, ImapMailboxSession } from "../src/types"

const CONNECTION: ImapConnection = {
  host: "imap.example.com",
  auth: { user: "reader@example.com", pass: "secret-password" },
}

describe("imap connector", () => {
  test("validates connection settings before creating the adapter", () => {
    expect(() => imap({ ...CONNECTION, host: " " })).toThrow("host must not be empty")
    expect(() => imap({ ...CONNECTION, auth: { user: "", pass: "secret" } })).toThrow(
      "auth.user must not be empty"
    )
    expect(() => imap({ ...CONNECTION, port: 70_000 })).toThrow(
      "port must be an integer between 1 and 65535"
    )
    expect(() => imap({ ...CONNECTION, connectTimeoutMs: 0 })).toThrow(
      "connectTimeoutMs must be a positive integer"
    )
  })

  test("returns a read-only gateway and rejects an already-aborted runtime", async () => {
    const adapter = imap(CONNECTION)
    expect(adapter.type).toBe("imap")

    const controller = new AbortController()
    controller.abort()

    await expect(
      adapter.connect({ projectId: "demo", connectorId: "mail", signal: controller.signal })
    ).rejects.toBeInstanceOf(ImapAbortedError)
  })

  test("uses secure, non-idling ImapFlow options and normalizes mailbox status", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      transport.mailboxes = [mailboxListResponse()]
    }

    const result = await fixture.client.listMailboxes()

    expect(fixture.options).toHaveLength(1)
    expect(fixture.options[0]).toMatchObject({
      host: "imap.example.com",
      port: 993,
      secure: true,
      servername: "imap.example.com",
      disableAutoIdle: true,
      logger: false,
      logRaw: false,
      emitLogs: false,
      connectionTimeout: 30_000,
      socketTimeout: 300_000,
      tls: { rejectUnauthorized: true },
    })
    expect(result).toEqual([
      {
        path: "Sent",
        name: "Sent",
        delimiter: "/",
        parentPath: "",
        flags: ["\\HasNoChildren"],
        specialUse: "\\Sent",
        listed: true,
        subscribed: true,
        status: {
          messages: 12,
          recent: 1,
          uidNext: 42,
          uidValidity: 123n,
          unseen: 3,
          highestModseq: 9n,
        },
      },
    ])
    expect(fixture.transports[0]?.events).toEqual(["connect", "list", "logout"])
  })

  test("opens a new read-only session for every mailbox operation", async () => {
    const fixture = clientFixture()

    const firstState = await fixture.client.withMailbox("INBOX", async (mailbox) => mailbox.state())
    const secondState = await fixture.client.withMailbox("Sent", async (mailbox) => mailbox.state())

    expect(firstState).toMatchObject({ path: "INBOX", uidValidity: 123n, readOnly: true })
    expect(secondState).toMatchObject({ path: "Sent", uidValidity: 123n, readOnly: true })
    expect(fixture.transports).toHaveLength(2)
    expect(fixture.transports[0]?.events).toEqual([
      "connect",
      "lock:INBOX:true",
      "release:INBOX",
      "logout",
    ])
    expect(fixture.transports[1]?.events).toEqual([
      "connect",
      "lock:Sent:true",
      "release:Sent",
      "logout",
    ])
  })

  test("releases the lock and logs out when the mailbox callback fails", async () => {
    const fixture = clientFixture()
    const failure = new Error("application failure")

    await expect(
      fixture.client.withMailbox("INBOX", async () => {
        throw failure
      })
    ).rejects.toBe(failure)

    expect(fixture.transports[0]?.events).toEqual([
      "connect",
      "lock:INBOX:true",
      "release:INBOX",
      "logout",
    ])
  })

  test("rejects a mailbox that was not actually opened read-only", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      transport.forceReadOnly = false
    }

    await expect(fixture.client.withMailbox("INBOX", async () => undefined)).rejects.toThrow(
      "was not opened read-only"
    )
    expect(fixture.transports[0]?.events).toContain("release:INBOX")
  })

  test("lists a bounded UID page and normalizes envelope, references, and MIME structure", async () => {
    const fixture = clientFixture()
    const since = new Date("2026-06-01T00:00:00.000Z")
    fixture.configure = (transport) => {
      transport.searchResult = [13, 11, 12]
      transport.messages = [message(12), message(11)]
    }

    const messages = await fixture.client.withMailbox("INBOX", (mailbox) =>
      mailbox.listMessages({ afterUid: 10, since, limit: 2 })
    )

    const transport = fixture.transports[0]
    expect(transport?.searchQuery).toEqual({ uid: "11:*", since })
    expect(transport?.fetchRange).toEqual([11, 12])
    expect(transport?.fetchQuery).toMatchObject({
      uid: true,
      envelope: true,
      internalDate: true,
      size: true,
      bodyStructure: true,
      headers: ["references"],
    })
    expect(messages.map((item) => item.uid)).toEqual([11, 12])
    expect(messages[0]).toMatchObject({
      internalDate: new Date("2026-07-10T08:00:00.000Z"),
      size: 1_024,
      headers: {},
      references: ["<root@example.com>", "<parent@example.com>"],
      envelope: {
        subject: "Project update",
        messageId: "<message-11@example.com>",
        inReplyTo: "<parent@example.com>",
        from: [{ name: "Client", address: "client@example.com" }],
      },
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          {
            part: "1",
            type: "text/plain",
            parameters: { charset: "utf-8" },
            declaredCharset: "utf-8",
          },
        ],
      },
    })
  })

  test("fetches requested headers and preserves repeated unfolded values", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      transport.searchResult = [11]
      transport.messages = [
        {
          ...message(11),
          headers: Buffer.from(
            [
              "References: <root@example.com>",
              "List-Id: first.example.com",
              "List-ID: second.example.com",
              "Auto-Submitted: auto-generated;",
              "\towner-email=robot@example.com",
              "",
            ].join("\r\n")
          ),
        },
      ]
    }

    const messages = await fixture.client.withMailbox("INBOX", (mailbox) =>
      mailbox.listMessages({
        limit: 1,
        headers: ["List-Id", "list-id", "AUTO-SUBMITTED"],
      })
    )

    expect(fixture.transports[0]?.fetchQuery?.headers).toEqual([
      "references",
      "list-id",
      "auto-submitted",
    ])
    expect(messages[0]?.headers).toEqual({
      "list-id": ["first.example.com", "second.example.com"],
      "auto-submitted": ["auto-generated; owner-email=robot@example.com"],
    })
    expect(messages[0]?.references).toEqual(["<root@example.com>"])
  })

  test("validates page inputs before issuing a search", async () => {
    const fixture = clientFixture()

    await expect(
      fixture.client.withMailbox("INBOX", (mailbox) =>
        mailbox.listMessages({ afterUid: 0, limit: 1_001 })
      )
    ).rejects.toThrow("Message page limit must be between 1 and 1000")
    expect(fixture.transports[0]?.searchQuery).toBeUndefined()
  })

  test("rejects invalid or excessive requested header names before searching", async () => {
    const fixture = clientFixture()

    await expect(
      fixture.client.withMailbox("INBOX", (mailbox) =>
        mailbox.listMessages({ limit: 1, headers: ["List-Id: injected"] })
      )
    ).rejects.toThrow("valid RFC 5322 field names")
    expect(fixture.transports[0]?.searchQuery).toBeUndefined()

    await expect(
      fixture.client.withMailbox("INBOX", (mailbox) =>
        mailbox.listMessages({
          limit: 1,
          headers: Array.from({ length: 65 }, (_, index) => `X-Test-${index}`),
        })
      )
    ).rejects.toThrow("No more than 64 message headers")
  })

  test("streams a MIME part within the byte limit", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      transport.downloadResult = download(["ab", "cd"], 4)
    }

    const result = await fixture.client.withMailbox("INBOX", async (mailbox) => {
      const part = await mailbox.downloadPart({ uid: 7, part: "2", maxBytes: 5 })
      return { meta: part.meta, body: await readAll(part.content) }
    })

    expect(result.body.toString("utf8")).toBe("abcd")
    expect(result.meta).toMatchObject({ expectedSize: 4, contentType: "application/pdf" })
    expect(fixture.transports[0]?.downloadRequest).toEqual({
      uid: 7,
      part: "2",
      options: { uid: true, maxBytes: 6 },
    })
  })

  test("distinguishes the source MIME charset from the downloaded content charset", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      transport.searchResult = [11]
      transport.messages = [
        {
          ...message(11),
          bodyStructure: {
            type: "multipart/alternative",
            childNodes: [
              { part: "1", type: "text/plain", parameters: { charset: "Windows-1252" } },
              { part: "2", type: "text/html", parameters: { charset: "Windows-1252" } },
            ],
          },
        },
      ]
      transport.downloadResult = {
        meta: {
          expectedSize: 18,
          contentType: "text/plain",
          charset: "utf-8",
          encoding: "quoted-printable",
        },
        content: Readable.from([Buffer.from("à l’étage\nEnvoyé", "utf8")]),
      }
    }

    const result = await fixture.client.withMailbox("INBOX", async (mailbox) => {
      const [message] = await mailbox.listMessages({ limit: 1 })
      const downloaded = await mailbox.downloadPart({ uid: 11, part: "1", maxBytes: 100 })
      return {
        bodyStructure: message?.bodyStructure,
        meta: downloaded.meta,
        content: await readAll(downloaded.content),
      }
    })

    expect(result.bodyStructure?.childNodes).toMatchObject([
      { part: "1", declaredCharset: "Windows-1252" },
      { part: "2", declaredCharset: "Windows-1252" },
    ])
    expect(result.meta).toMatchObject({
      contentCharset: "utf-8",
      transferEncoding: "quoted-printable",
    })
    expect(result.content.toString("utf8")).toBe("à l’étage\nEnvoyé")
  })

  test("does not use the message-level expected size as the MIME part limit", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      transport.downloadResult = download(["abcd"], 10)
    }

    const body = await fixture.client.withMailbox("INBOX", async (mailbox) => {
      const part = await mailbox.downloadPart({ uid: 7, part: "2", maxBytes: 5 })
      return readAll(part.content)
    })

    expect(body.toString("utf8")).toBe("abcd")
  })

  test("enforces the byte limit while consuming an inaccurately-sized stream", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      transport.downloadResult = download(["ab", "cd"], 3)
    }

    await expect(
      fixture.client.withMailbox("INBOX", async (mailbox) => {
        const part = await mailbox.downloadPart({ uid: 7, part: "2", maxBytes: 3 })
        await readAll(part.content)
      })
    ).rejects.toBeInstanceOf(ImapDownloadTooLargeError)
  })

  test("destroys an unconsumed part when its mailbox callback ends", async () => {
    const fixture = clientFixture()
    const source = Readable.from([Buffer.from("body")])
    fixture.configure = (transport) => {
      transport.downloadResult = downloadFromStream(source, 4)
    }
    let content: Readable | undefined

    await fixture.client.withMailbox("INBOX", async (mailbox) => {
      content = (await mailbox.downloadPart({ uid: 7, part: "1", maxBytes: 10 })).content
    })

    expect(content?.destroyed).toBe(true)
    expect(source.destroyed).toBe(true)
  })

  test("reports an unavailable part when the server returns no content", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      // ImapFlow resolves an empty object when the requested part is absent.
      transport.downloadResult = {}
    }

    await expect(
      fixture.client.withMailbox("INBOX", (mailbox) =>
        mailbox.downloadPart({ uid: 7, part: "2", maxBytes: 5 })
      )
    ).rejects.toBeInstanceOf(ImapPartUnavailableError)

    // Teardown must surface the typed error, not a masking `source.destroy` TypeError
    // from an entry poisoned with an undefined stream.
    expect(fixture.transports[0]?.events).toEqual([
      "connect",
      "lock:INBOX:true",
      "download",
      "release:INBOX",
      "logout",
    ])
  })

  test("reports an unavailable part for a partial download result", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      // The `part === "1"` fetch-miss path resolves { response: false, chunk: false }.
      transport.downloadResult = { response: false, chunk: false } as Partial<DownloadObject>
    }

    await expect(
      fixture.client.withMailbox("INBOX", (mailbox) =>
        mailbox.downloadPart({ uid: 7, part: "1", maxBytes: 5 })
      )
    ).rejects.toBeInstanceOf(ImapPartUnavailableError)
  })

  test("makes a mailbox session unusable after its callback", async () => {
    const fixture = clientFixture()
    let escaped: ImapMailboxSession | undefined

    await fixture.client.withMailbox("INBOX", async (mailbox) => {
      escaped = mailbox
    })

    expect(() => escaped?.state()).toThrow("Mailbox session is no longer active")
  })

  test("close aborts active transport work, is idempotent, and prevents new operations", async () => {
    const fixture = clientFixture()
    let searchStartedResolve: (() => void) | undefined
    const searchStarted = new Promise<void>((resolve) => {
      searchStartedResolve = resolve
    })
    fixture.configure = (transport) => {
      transport.blockSearch = true
      transport.onSearchStart = () => searchStartedResolve?.()
    }

    const operation = fixture.client.withMailbox("INBOX", (mailbox) =>
      mailbox.listMessages({ limit: 1 })
    )
    await searchStarted
    await fixture.client.close()
    await fixture.client.close()

    await expect(operation).rejects.toBeInstanceOf(ImapAbortedError)
    expect(fixture.transports[0]?.events.filter((event) => event === "close")).toHaveLength(1)
    await expect(fixture.client.listMailboxes()).rejects.toBeInstanceOf(ImapAbortedError)
  })

  test("an operation signal aborts only its session and leaves the gateway reusable", async () => {
    const fixture = clientFixture()
    const controller = new AbortController()
    let transportIndex = 0
    let searchStartedResolve: (() => void) | undefined
    const searchStarted = new Promise<void>((resolve) => {
      searchStartedResolve = resolve
    })
    fixture.configure = (transport) => {
      if (transportIndex++ === 0) {
        transport.blockSearch = true
        transport.onSearchStart = () => searchStartedResolve?.()
      } else {
        transport.mailboxes = [mailboxListResponse()]
      }
    }

    const operation = fixture.client.withMailbox(
      "INBOX",
      (mailbox) => mailbox.listMessages({ limit: 1 }),
      { signal: controller.signal }
    )
    await searchStarted
    controller.abort()

    await expect(operation).rejects.toBeInstanceOf(ImapAbortedError)
    expect(await fixture.client.listMailboxes()).toHaveLength(1)
  })

  test("the connector lifecycle signal closes the gateway", async () => {
    const fixture = clientFixture()

    fixture.lifecycle.abort()

    await expect(fixture.client.listMailboxes()).rejects.toBeInstanceOf(ImapAbortedError)
    expect(fixture.transports).toHaveLength(0)
  })

  test("redacts the password from connection failures", async () => {
    const fixture = clientFixture()
    fixture.configure = (transport) => {
      transport.connectError = new Error("server rejected secret-password\r\nLOGIN")
    }

    let failure: unknown
    try {
      await fixture.client.listMailboxes()
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(ImapConnectorError)
    expect(String(failure)).not.toContain("secret-password")
    expect(String(failure)).toContain("[redacted]")
  })
})

function clientFixture() {
  const transports: FakeTransport[] = []
  const options: ImapFlowOptions[] = []
  const lifecycle = new AbortController()
  const fixture: {
    client: ReturnType<typeof createImapClient>
    transports: FakeTransport[]
    options: ImapFlowOptions[]
    lifecycle: AbortController
    configure?: (transport: FakeTransport) => void
  } = {
    client: undefined as never,
    transports,
    options,
    lifecycle,
  }

  fixture.client = createImapClient(CONNECTION, lifecycle.signal, (flowOptions) => {
    options.push(flowOptions)
    const transport = new FakeTransport()
    fixture.configure?.(transport)
    transports.push(transport)
    return transport
  })

  return fixture
}

class FakeTransport implements ImapTransport {
  usable = false
  mailbox: MailboxObject | false = false
  readonly events: string[] = []
  mailboxes: ListResponse[] = []
  searchResult: number[] | false = []
  messages: FetchMessageObject[] = []
  downloadResult: Partial<DownloadObject> = download([], 0)
  searchQuery?: SearchObject
  fetchRange?: string | number[] | SearchObject
  fetchQuery?: FetchQueryObject
  downloadRequest?: { uid: number; part: string; options: object }
  forceReadOnly: boolean | undefined
  connectError: Error | undefined
  blockSearch = false
  onSearchStart: (() => void) | undefined
  private searchReject: ((error: Error) => void) | undefined
  private closed = false

  async connect(): Promise<void> {
    this.events.push("connect")
    if (this.connectError) {
      throw this.connectError
    }
    this.usable = true
  }

  async logout(): Promise<void> {
    this.events.push("logout")
    this.usable = false
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.events.push("close")
    this.usable = false
    this.searchReject?.(new Error("transport closed"))
  }

  async list(_options?: ListOptions): Promise<ListResponse[]> {
    this.events.push("list")
    return this.mailboxes
  }

  async getMailboxLock(
    path: string | string[],
    options?: { readOnly?: boolean }
  ): Promise<MailboxLockObject> {
    const mailboxPath = Array.isArray(path) ? path.join("/") : path
    const readOnly = this.forceReadOnly ?? options?.readOnly === true
    this.events.push(`lock:${mailboxPath}:${String(options?.readOnly)}`)
    this.mailbox = {
      path: mailboxPath,
      delimiter: "/",
      flags: new Set(),
      uidValidity: 123n,
      uidNext: 42,
      exists: 12,
      readOnly,
    }
    return {
      path: mailboxPath,
      release: () => this.events.push(`release:${mailboxPath}`),
    }
  }

  async search(query: SearchObject, _options?: { uid?: boolean }): Promise<number[] | false> {
    this.events.push("search")
    this.searchQuery = query
    this.onSearchStart?.()
    if (this.blockSearch) {
      return new Promise<number[] | false>((_resolve, reject) => {
        this.searchReject = reject
      })
    }
    return this.searchResult
  }

  async fetchAll(
    range: string | number[] | SearchObject,
    query: FetchQueryObject,
    _options?: FetchOptions
  ): Promise<FetchMessageObject[]> {
    this.events.push("fetchAll")
    this.fetchRange = range
    this.fetchQuery = query
    if (!Array.isArray(range)) {
      return this.messages
    }
    return this.messages.filter((item) => range.includes(item.uid))
  }

  async download(
    range: string | number | bigint,
    part = "",
    options: { uid?: boolean; maxBytes?: number; chunkSize?: number } = {}
  ): Promise<Partial<DownloadObject>> {
    this.events.push("download")
    this.downloadRequest = { uid: Number(range), part, options }
    return this.downloadResult
  }
}

function mailboxListResponse(): ListResponse {
  return {
    path: "Sent",
    pathAsListed: "Sent",
    name: "Sent",
    delimiter: "/",
    parent: [],
    parentPath: "",
    flags: new Set(["\\HasNoChildren"]),
    specialUse: "\\Sent",
    listed: true,
    subscribed: true,
    status: {
      path: "Sent",
      messages: 12,
      recent: 1,
      uidNext: 42,
      uidValidity: 123n,
      unseen: 3,
      highestModseq: 9n,
    },
  }
}

function message(uid: number): FetchMessageObject {
  return {
    seq: uid - 10,
    uid,
    internalDate: "2026-07-10T08:00:00.000Z",
    size: 1_024,
    envelope: {
      date: new Date("2026-07-10T07:55:00.000Z"),
      subject: "Project update",
      messageId: `<message-${uid}@example.com>`,
      inReplyTo: "<parent@example.com>",
      from: [{ name: "Client", address: "client@example.com" }],
      to: [{ name: "BeHome", address: "contact@example.com" }],
    },
    headers: Buffer.from(
      "References: <root@example.com>\r\n\t<parent@example.com> <root@example.com>\r\n"
    ),
    bodyStructure: {
      type: "multipart/mixed",
      childNodes: [
        {
          part: "1",
          type: "text/plain",
          parameters: { charset: "utf-8" },
          size: 100,
        },
      ],
    },
  }
}

function download(chunks: readonly string[], expectedSize: number): DownloadObject {
  return downloadFromStream(Readable.from(chunks.map((chunk) => Buffer.from(chunk))), expectedSize)
}

function downloadFromStream(content: Readable, expectedSize: number): DownloadObject {
  return {
    meta: {
      expectedSize,
      contentType: "application/pdf",
      filename: "document.pdf",
    },
    content,
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const value of stream) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
