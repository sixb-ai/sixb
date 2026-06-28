import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import type { PandaDocWebhookEventContext } from "../src"
import { pandaDocEventsWebhook, pandadoc } from "../src"
import { CONTEXT, collect, json, mockFetch } from "./helpers"

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof pandaDocEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof pandaDocEventsWebhook>["handle"]>[0]

const sign = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("hex")

describe("pandadoc webhook resources", () => {
  const originalFetch = globalThis.fetch

  test("registers inbound webhook only when onEvent is set", () => {
    expect(pandadoc({ apiKey: "pd-key" }).webhooks).toBeUndefined()
    expect(pandadoc({ apiKey: "pd-key", onEvent: () => {} }).webhooks).toHaveLength(1)
  })

  test("subscription and event resources hit exact paths", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = []
    mockFetch((input, init) => {
      const url = new URL(String(input))
      calls.push({
        method: init?.method ?? "",
        path: `${url.pathname}${url.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (url.pathname === "/public/v1/webhook-events") {
        return Promise.resolve(json({ items: [{ id: "event1" }] }))
      }
      return Promise.resolve(
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : json({ uuid: "sub1", items: [{ uuid: "sub1" }] })
      )
    })

    const client = await pandadoc({ apiKey: "pd-key" }).connect(CONTEXT)
    await client.webhookSubscriptions.create({
      name: "Sixb",
      url: "https://app.example/api/webhooks/pandadoc/events",
      triggers: ["document_state_changed"],
      payload: ["fields"],
    })
    await client.webhookSubscriptions.updateSharedKey("sub1")
    await client.webhookSubscriptions.delete("sub1")
    const events = await collect(client.webhookEvents.listAll({ count: 2 }))

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/public/v1/webhook-subscriptions",
        body: {
          name: "Sixb",
          url: "https://app.example/api/webhooks/pandadoc/events",
          triggers: ["document_state_changed"],
          payload: ["fields"],
        },
      },
      { method: "PATCH", path: "/public/v1/webhook-subscriptions/sub1/shared-key" },
      { method: "DELETE", path: "/public/v1/webhook-subscriptions/sub1" },
      { method: "GET", path: "/public/v1/webhook-events?count=2&page=1" },
    ])
    expect(events.map((event) => event.id)).toEqual(["event1"])

    globalThis.fetch = originalFetch
  })
})

describe("pandadoc inbound events webhook", () => {
  test("verifies signature, dispatches each event, and responds 200", async () => {
    const received: PandaDocWebhookEventContext[] = []
    const webhook = pandaDocEventsWebhook({
      sharedKey: "shared",
      onEvent: (context) => {
        received.push(context)
      },
    })
    const body = JSON.stringify([
      { event: "document_state_changed", data: { id: "doc1", status: "document.completed" } },
      {
        event: "recipient_completed",
        data: { id: "doc1", action_by: { email: "buyer@example.com" } },
      },
    ])
    const request = new Request(`https://x/hook?signature=${sign("shared", body)}`, {
      method: "POST",
    })
    const sixb = { id: "demo" }
    const client = () => Promise.resolve({} as never)

    await webhook.verify?.({
      request,
      rawBody: new TextEncoder().encode(body),
    } as unknown as VerifyCtx)

    const result = await webhook.handle({
      request,
      body: webhook.body.parse(JSON.parse(body)),
      sixb,
      client,
    } as unknown as HandleCtx)

    expect(result).toEqual({ status: 200 })
    expect(received).toHaveLength(2)
    expect(received[0]?.event.event).toBe("document_state_changed")
    expect(received[0]?.events).toHaveLength(2)
    expect(received[0]?.sixb).toBe(sixb as never)
    expect(received[0]?.client).toBe(client)
  })

  test("rejects invalid signature when shared key is configured", async () => {
    const webhook = pandaDocEventsWebhook({ sharedKey: "shared", onEvent: () => {} })

    await expect(
      webhook.verify?.({
        request: new Request("https://x/hook?signature=bad"),
        rawBody: new TextEncoder().encode("[]"),
      } as unknown as VerifyCtx)
    ).rejects.toThrow("Invalid webhook signature")
  })

  test("skips verification without a shared key", () => {
    const webhook = pandaDocEventsWebhook({ onEvent: () => {} })

    expect(() =>
      webhook.verify?.({
        request: new Request("https://x/hook"),
        rawBody: new TextEncoder().encode("[]"),
      } as unknown as VerifyCtx)
    ).not.toThrow()
  })

  test("rejects an unexpected payload shape", () => {
    const webhook = pandaDocEventsWebhook({ onEvent: () => {} })
    expect(() => webhook.body.parse({ event: "document_state_changed" })).toThrow(
      "Unexpected webhook payload"
    )
  })
})
