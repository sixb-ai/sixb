import { afterEach, describe, expect, test } from "bun:test"
import {
  MicrosoftConfigurationError,
  MicrosoftMailSubmissionError,
  MicrosoftProtocolError,
} from "../src"
import { apiError, collect, connect, GRAPH, json, mockFetch, restoreFetch } from "./helpers"

afterEach(restoreFetch)
const mailbox = "user+tag@example.com"
const base = `${GRAPH}users/user%2Btag%40example.com`

describe("Outlook messages and folders", () => {
  // Countercheck: remove IdType from mailHeaders; this must fail on both pages.
  test("preserves immutable IDs and body preferences on every page, including empty pages", async () => {
    const cursor = `${base}/messages?$skiptoken=opaque%2B%2F%3D`
    const requests = mockFetch((r) =>
      r.url === cursor
        ? json({ value: [{ id: "immutable", subject: "hello" }] })
        : json({ value: [], "@odata.nextLink": cursor })
    )
    const client = await connect()
    expect(
      await collect(
        client.mail.messages.listAll(mailbox, {
          select: ["subject"],
          bodyContentType: "text",
          top: 2,
        })
      )
    ).toEqual([{ id: "immutable", subject: "hello" }])
    expect(new URL(requests[0].url).searchParams.get("$select")).toBe("id,subject")
    expect(new URL(requests[0].url).searchParams.get("$top")).toBe("2")
    expect(requests[1].url).toBe(cursor)
    for (const r of requests) {
      expect(r.headers.get("prefer")).toBe('IdType="ImmutableId", outlook.body-content-type="text"')
      expect(r.headers.get("authorization")).toBe("Bearer graph-token")
    }
  })

  test("encodes folder/message IDs and supports projections, filtering and search", async () => {
    const requests = mockFetch((r) =>
      r.url.includes("/messages/A")
        ? json({ id: "A+/=", body: { contentType: "html", content: "<b>x</b>" } })
        : json({ value: [] })
    )
    const { mail } = await connect()
    await mail.messages.listInFolder(mailbox, "inbox", {
      filter: "isRead eq false",
      orderBy: "receivedDateTime desc",
    })
    await collect(mail.messages.listAllInFolder(mailbox, "A+/=", { search: '"subject:invoice"' }))
    const message = await mail.messages.get(mailbox, "A+/=", {
      select: ["internetMessageHeaders"],
      bodyContentType: "html",
    })
    expect(requests[0].url).toStartWith(`${base}/mailFolders/inbox/messages?`)
    expect(new URL(requests[0].url).searchParams.get("$filter")).toBe("isRead eq false")
    expect(requests[1].url).toStartWith(`${base}/mailFolders/A%2B%2F%3D/messages?`)
    expect(new URL(requests[1].url).searchParams.get("$search")).toBe('"subject:invoice"')
    expect(requests[2].url).toStartWith(`${base}/messages/A%2B%2F%3D?`)
    expect(message.body?.contentType).toBe("html")
  })

  test("returns MIME as a consumable response and preserves provider errors", async () => {
    const requests = mockFetch(
      () =>
        new Response("Subject: hello\r\n\r\nbody", {
          headers: { "content-type": "message/rfc822" },
        })
    )
    const { mail } = await connect()
    expect(await (await mail.messages.getMime(mailbox, "id")).text()).toContain("Subject: hello")
    expect(requests[0].url).toBe(`${base}/messages/id/$value`)
    mockFetch(() => apiError(403))
    await expect(mail.messages.getMime(mailbox, "id")).rejects.toMatchObject({
      status: 403,
      code: "accessDenied",
    })
  })

  test("keeps draft creation, patching, replies and forwards separate from sending", async () => {
    const requests = mockFetch(() => json({ id: "draft", isDraft: true }, 201))
    const { messages } = (await connect()).mail
    await messages.createDraft(mailbox, {
      subject: "Hi",
      body: { contentType: "text", content: "Hi" },
      internetMessageHeaders: [{ name: "x-sixb-id", value: "correlation" }],
    })
    await messages.updateDraft(mailbox, "draft", {
      subject: "Updated",
      toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
    })
    await messages.update(mailbox, "received", {
      isRead: true,
      categories: ["Sixb"],
      flag: { flagStatus: "flagged" },
    })
    await messages.createReply(mailbox, "received", { comment: "Thanks" })
    await messages.createReplyAll(mailbox, "received", {
      message: { body: { contentType: "text", content: "Thanks all" } },
    })
    await messages.createForward(mailbox, "received", {
      toRecipients: [{ emailAddress: { address: "other@example.com" } }],
    })
    expect(requests.map((r) => r.method)).toEqual([
      "POST",
      "PATCH",
      "PATCH",
      "POST",
      "POST",
      "POST",
    ])
    expect(requests.map((r) => r.url)).toEqual([
      `${base}/messages`,
      `${base}/messages/draft`,
      `${base}/messages/received`,
      `${base}/messages/received/createReply`,
      `${base}/messages/received/createReplyAll`,
      `${base}/messages/received/createForward`,
    ])
    expect(JSON.parse(String(requests[1].init.body))).not.toHaveProperty("isDraft")
    expect(JSON.parse(String(requests[3].init.body))).toEqual({ comment: "Thanks" })
    expect(requests.every((r) => r.headers.get("prefer") === 'IdType="ImmutableId"')).toBe(true)
  })

  test("send returns accepted, never a fabricated delivered message", async () => {
    const requests = mockFetch(
      () => new Response(null, { status: 202, headers: { "request-id": "request" } })
    )
    const { messages } = (await connect()).mail
    expect(await messages.send(mailbox, "draft")).toEqual({
      status: "accepted",
      requestId: "request",
    })
    expect(requests[0].init.body).toBeUndefined()
    await messages.sendMail(mailbox, { subject: "Hello" }, { saveToSentItems: false })
    expect(JSON.parse(String(requests[1].init.body))).toEqual({
      message: { subject: "Hello" },
      saveToSentItems: false,
    })
    expect(requests[1].url).toBe(`${base}/sendMail`)
    mockFetch(() => json({ id: "unexpected" }, 200))
    await expect(messages.send(mailbox, "draft")).rejects.toBeInstanceOf(MicrosoftProtocolError)
  })

  // Countercheck: remove the retry gate in createMicrosoftHttp; custom policies replay this send.
  test("unsafe operations cannot be replayed by a custom retry policy", async () => {
    const { mail } = await connect({
      retry: { maxRetries: 2, shouldRetry: () => true, delayMs: () => 0 },
    })
    for (const status of [401, 403, 412, 429, 503]) {
      const requests = mockFetch(() => apiError(status))
      await expect(mail.messages.send(mailbox, "draft")).rejects.toMatchObject({ status })
      await expect(mail.messages.move(mailbox, "message", "inbox")).rejects.toMatchObject({
        status,
      })
      expect(requests).toHaveLength(2)
    }
  })

  test("lost submission responses expose uncertainty without retrying", async () => {
    const requests = mockFetch(() => {
      throw new TypeError("connection lost")
    })
    const { messages } = (await connect()).mail
    await expect(messages.send(mailbox, "draft")).rejects.toMatchObject({
      name: "MicrosoftMailSubmissionError",
      outcomeUnknown: true,
      cause: { message: "connection lost" },
    })
    await expect(messages.sendMail(mailbox, { subject: "hello" })).rejects.toBeInstanceOf(
      MicrosoftMailSubmissionError
    )
    expect(requests).toHaveLength(2)
  })

  test("move/copy return the provider ID, and delete sends no request body", async () => {
    const requests = mockFetch((r) =>
      r.method === "DELETE" ? new Response(null, { status: 204 }) : json({ id: "returned-id" }, 201)
    )
    const { messages } = (await connect()).mail
    expect((await messages.move(mailbox, "source", "deleteditems")).id).toBe("returned-id")
    await messages.copy(mailbox, "source", "archive")
    await messages.delete(mailbox, "source")
    expect(JSON.parse(String(requests[0].init.body))).toEqual({ destinationId: "deleteditems" })
    expect(requests[1].url).toBe(`${base}/messages/source/copy`)
    expect(requests[2].init.body).toBeUndefined()
  })

  test("folder hierarchy, hidden folders and creation use their own API contracts", async () => {
    const requests = mockFetch((r) =>
      r.method === "DELETE"
        ? new Response(null, { status: 204 })
        : r.method === "GET" && !r.url.endsWith("/inbox")
          ? json({ value: [{ id: "folder" }] })
          : json({ id: "folder" })
    )
    const { folders } = (await connect()).mail
    await folders.list(mailbox, { includeHiddenFolders: true })
    await collect(folders.listAll(mailbox))
    await folders.get(mailbox, "inbox")
    await folders.listChildren(mailbox, "inbox")
    await collect(folders.listAllChildren(mailbox, "inbox", { includeHiddenFolders: true }))
    await folders.create(mailbox, "Sixb")
    await folders.create(mailbox, "Nested", { parentId: "folder", isHidden: true })
    await folders.rename(mailbox, "folder", "New")
    await folders.delete(mailbox, "folder")
    expect(new URL(requests[0].url).searchParams.get("includeHiddenFolders")).toBe("true")
    expect(requests[3].url).toBe(`${base}/mailFolders/inbox/childFolders`)
    expect(JSON.parse(String(requests[6].init.body))).toEqual({
      displayName: "Nested",
      isHidden: true,
    })
    expect(JSON.parse(String(requests[7].init.body))).toEqual({ displayName: "New" })
    expect(requests[8].method).toBe("DELETE")
  })

  test("rejects malformed query/header inputs before network I/O", async () => {
    const requests = mockFetch(() => json({ value: [] }))
    const { messages } = (await connect()).mail
    await expect(
      messages.list(mailbox, { search: '"hello"', filter: "isRead eq false" })
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
    await expect(messages.list(mailbox, { top: 0 })).rejects.toBeInstanceOf(
      MicrosoftConfigurationError
    )
    expect(() =>
      messages.createDraft(mailbox, {
        internetMessageHeaders: [{ name: "Authorization", value: "no" }],
      })
    ).toThrow(MicrosoftConfigurationError)
    // Untyped JavaScript callers can violate the discriminated input union too.
    expect(() =>
      messages.createReply(
        mailbox,
        "id",
        JSON.parse('{"comment":"x","message":{"body":{"contentType":"text","content":"y"}}}')
      )
    ).toThrow(MicrosoftConfigurationError)
    expect(requests).toHaveLength(0)
  })

  test("rejects foreign continuation URLs and pagination loops", async () => {
    const { messages } = (await connect()).mail
    for (const next of ["https://attacker.example/mail", `${base}/messages`]) {
      const requests = mockFetch(() => json({ value: [], "@odata.nextLink": next }))
      await expect(collect(messages.listAll(mailbox))).rejects.toBeInstanceOf(
        MicrosoftProtocolError
      )
      expect(requests).toHaveLength(1)
    }
  })
})

describe("Outlook delta", () => {
  // Countercheck: stop iteration on an empty value array; the removal/checkpoint disappears.
  test("retains folder removals, empty pages and final checkpoint without changing IDs", async () => {
    const next = `${base}/mailFolders/inbox/messages/delta?$skiptoken=opaque%2B`
    const checkpoint = `${base}/mailFolders/inbox/messages/delta?$deltatoken=end`
    const requests = mockFetch((r) =>
      r.url === next
        ? json({
            value: [{ id: "moved", "@removed": { reason: "deleted" } }],
            "@odata.deltaLink": checkpoint,
          })
        : json({ value: [], "@odata.nextLink": next })
    )
    const { messages } = (await connect()).mail
    const pages = await collect(
      messages.delta.pages(mailbox, "inbox", {
        select: ["subject", "parentFolderId"],
        pageSize: 2,
        bodyContentType: "text",
      })
    )
    expect(pages).toHaveLength(2)
    expect(pages[1].value[0]).toEqual({ id: "moved", "@removed": { reason: "deleted" } })
    expect(pages[1]["@odata.deltaLink"]).toBe(checkpoint)
    expect(requests[1].url).toBe(next)
    expect(requests[1].headers.get("prefer")).toBe(
      'IdType="ImmutableId", outlook.body-content-type="text", odata.maxpagesize=2'
    )
  })

  test("folder delta uses select and maxpagesize rather than unsupported message query options", async () => {
    const requests = mockFetch(() =>
      json({
        value: [{ id: "f", "@removed": { reason: "deleted" } }],
        "@odata.deltaLink": `${base}/mailFolders/delta?$deltatoken=f`,
      })
    )
    const { folders } = (await connect()).mail
    const pages = await collect(
      folders.delta.pages(mailbox, { select: ["displayName"], pageSize: 2 })
    )
    expect(pages[0].value[0]["@removed"]).toEqual({ reason: "deleted" })
    expect(new URL(requests[0].url).searchParams.get("$select")).toBe("id,displayName")
    expect(new URL(requests[0].url).searchParams.has("$top")).toBe(false)
    expect(requests[0].headers.get("prefer")).toContain("odata.maxpagesize=2")
  })

  test("saved cursors are opaque and cannot be combined with new query options", async () => {
    const cursor = `${base}/mailFolders('inbox')/messages/delta?$deltatoken=opaque%2F%2B`
    const requests = mockFetch(() => json({ value: [], "@odata.deltaLink": cursor }))
    const { messages } = (await connect()).mail
    await messages.delta.list(mailbox, "inbox", { cursor })
    expect(requests[0].url).toBe(cursor)
    await expect(
      messages.delta.list(mailbox, "inbox", { cursor, select: ["subject"] })
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
    await expect(
      messages.delta.list(mailbox, "inbox", { filter: "isRead eq false" })
    ).rejects.toBeInstanceOf(MicrosoftConfigurationError)
    expect(requests).toHaveLength(1)
  })

  test("delta validates links, cycles, and propagates expired-token errors", async () => {
    const { messages } = (await connect()).mail
    for (const body of [
      { value: [] },
      { value: [], "@odata.deltaLink": "https://attacker.example/x" },
      { value: [], "@odata.nextLink": `${base}/x`, "@odata.deltaLink": `${base}/y` },
    ]) {
      mockFetch(() => json(body))
      await expect(messages.delta.list(mailbox, "inbox")).rejects.toBeInstanceOf(
        MicrosoftProtocolError
      )
    }
    mockFetch(() =>
      json({ value: [], "@odata.nextLink": `${base}/mailFolders/inbox/messages/delta` })
    )
    await expect(collect(messages.delta.pages(mailbox, "inbox"))).rejects.toBeInstanceOf(
      MicrosoftProtocolError
    )
    mockFetch(() => apiError(410, "syncStateNotFound"))
    await expect(messages.delta.list(mailbox, "inbox")).rejects.toMatchObject({
      status: 410,
      code: "syncStateNotFound",
    })
  })
})
