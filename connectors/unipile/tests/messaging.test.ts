import { afterEach, expect, test } from "bun:test"
import { collect, createTestClient, json, originalFetch, query, recorder } from "./helpers"

afterEach(() => {
  globalThis.fetch = originalFetch
})

function message(id: string) {
  return {
    object: "Message",
    id,
    account_id: "account-1",
    chat_id: "chat-1",
    provider_id: `provider-${id}`,
    chat_provider_id: "provider-chat-1",
    sender_id: "ACo1",
    text: "Hello",
    timestamp: "2026-08-10T10:00:00.000Z",
    is_sender: 0,
    attachments: [],
    reactions: [],
    seen: 1,
    seen_by: {},
    delivered: 1,
    hidden: 0,
    deleted: 0,
    edited: 0,
    is_event: 0,
  }
}

test("chats list serializes filters and comma-separated account ids", async () => {
  const calls = recorder([json({ object: "ChatList", items: [], cursor: null })])
  const client = await createTestClient()

  await client.chats.list({
    account_id: ["account-1", "account-2"],
    account_type: "LINKEDIN",
    after: "2026-08-01T00:00:00.000Z",
    unread: true,
    limit: 50,
  })

  const params = query(calls[0]?.url ?? "")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/chats")
  expect(params.getAll("account_id")).toEqual(["account-1,account-2"])
  expect(params.get("account_type")).toBe("LINKEDIN")
  expect(params.get("after")).toBe("2026-08-01T00:00:00.000Z")
  expect(params.get("unread")).toBe("true")
  expect(params.get("limit")).toBe("50")
})

test("chats get and listAll use the documented routes", async () => {
  const chat = {
    object: "Chat",
    id: "chat-1",
    account_id: "account-1",
    account_type: "LINKEDIN",
    provider_id: "provider-chat-1",
    name: "Ada",
    type: 0,
    timestamp: "2026-08-10T10:00:00.000Z",
    unread_count: 0,
    archived: 0,
    muted_until: null,
    read_only: 0,
  }
  const calls = recorder([
    json(chat),
    json({ object: "ChatList", items: [chat], cursor: "chat-next" }),
    json({ object: "ChatList", items: [], cursor: null }),
  ])
  const client = await createTestClient()

  expect((await client.chats.get("chat/one")).id).toBe("chat-1")
  expect(await collect(client.chats.listAll({ account_id: "account-1" }))).toHaveLength(1)

  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/chats/chat%2Fone")
  expect(query(calls[2]?.url ?? "").get("cursor")).toBe("chat-next")
  expect(query(calls[2]?.url ?? "").get("account_id")).toBe("account-1")
})

test("start creates text-only multipart form data", async () => {
  const calls = recorder([
    json({ object: "ChatStarted", chat_id: "chat-1", message_id: "message-1" }),
  ])
  const client = await createTestClient()

  const started = await client.chats.start({
    account_id: "account-1",
    attendees_ids: ["ACo1", "ACo2"],
    text: "Approved message",
  })

  const body = calls[0]?.body
  expect(started.chat_id).toBe("chat-1")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/chats")
  expect(calls[0]?.method).toBe("POST")
  expect(body).toBeInstanceOf(FormData)
  expect((body as FormData).get("account_id")).toBe("account-1")
  expect((body as FormData).get("text")).toBe("Approved message")
  expect((body as FormData).getAll("attendees_ids")).toEqual(["ACo1", "ACo2"])
  expect(calls[0]?.headers.has("content-type")).toBe(false)
})

test("message history follows cursors while preserving filters", async () => {
  const calls = recorder([
    json({ object: "MessageList", items: [message("m1")], cursor: "messages-next" }),
    json({ object: "MessageList", items: [message("m2")], cursor: null }),
  ])
  const client = await createTestClient()

  const messages = await collect(
    client.messages.listAllForChat("chat-1", {
      limit: 1,
      after: "2026-08-01T00:00:00.000Z",
      sender_id: "ACo1",
    })
  )

  expect(messages.map((item) => item.id)).toEqual(["m1", "m2"])
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/chats/chat-1/messages")
  expect(query(calls[1]?.url ?? "").get("cursor")).toBe("messages-next")
  expect(query(calls[1]?.url ?? "").get("limit")).toBe("1")
  expect(query(calls[1]?.url ?? "").get("after")).toBe("2026-08-01T00:00:00.000Z")
  expect(query(calls[1]?.url ?? "").get("sender_id")).toBe("ACo1")
})

test("send creates multipart form data and carries the account guard", async () => {
  const calls = recorder([json({ object: "MessageSent", message_id: "m1" })])
  const client = await createTestClient()

  const sent = await client.messages.send("chat/one", {
    text: "Approved reply",
    account_id: "account-1",
  })

  const body = calls[0]?.body
  expect(sent.message_id).toBe("m1")
  expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/chats/chat%2Fone/messages")
  expect(body).toBeInstanceOf(FormData)
  expect((body as FormData).get("text")).toBe("Approved reply")
  expect((body as FormData).get("account_id")).toBe("account-1")
  expect(calls[0]?.headers.has("content-type")).toBe(false)
})

test("start rejects empty attendee lists", async () => {
  const client = await createTestClient()

  expect(() =>
    client.chats.start({ account_id: "account-1", attendees_ids: [], text: "Hello" })
  ).toThrow("attendees_ids must contain at least one value")
})
