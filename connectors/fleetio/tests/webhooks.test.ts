import { afterEach, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { noopLogger } from "@sixb/core"
import type { FleetioEventContext } from "../src"
import { fleetio, fleetioEventsWebhook } from "../src"
import { createTestClient, empty, json, page, recorder, route } from "./helpers"

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof fleetioEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof fleetioEventsWebhook>["handle"]>[0]

const SECRET = "shared-key"
const BODY = JSON.stringify({
  id: 12283768,
  event: "work_order_updated",
  timestamp: "2026-11-05T11:49:21.000-07:00",
  triggered_by: "sam@example.com",
  payload: { id: 42, number: "1042" },
})

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}

function verifyCtx(body: string, signature: string | null): VerifyCtx {
  return {
    request: new Request("https://app.example/api/webhooks/fleetio/events", {
      method: "POST",
      headers: signature ? { "x-fleetio-webhook-signature": signature } : {},
    }),
    rawBody: new TextEncoder().encode(body),
  } as unknown as VerifyCtx
}

function handleCtx(body: unknown): HandleCtx {
  return {
    body,
    request: new Request("https://app.example/api/webhooks/fleetio/events", { method: "POST" }),
    sixb: {},
    logger: noopLogger,
    client: async () => ({}),
  } as unknown as HandleCtx
}

describe("fleetio events webhook", () => {
  test("registers the route only when onEvent is set", () => {
    const base = { apiKey: "key", accountToken: "account" }

    expect(fleetio(base).webhooks).toBeUndefined()
    expect(fleetio({ ...base, webhookSecret: SECRET, onEvent: () => {} }).webhooks).toHaveLength(1)
  })

  test("refuses to build without a secret unless told to", () => {
    const base = { apiKey: "key", accountToken: "account", onEvent: () => {} }

    expect(() => fleetio(base)).toThrow("webhookSecret")
    expect(fleetio({ ...base, webhookAllowUnverified: true }).webhooks).toHaveLength(1)
  })

  test("accepts Fleetio's hex signature of the raw body", async () => {
    const webhook = fleetioEventsWebhook({ credential: SECRET, onEvent: () => {} })

    await webhook.verify?.(verifyCtx(BODY, sign(SECRET, BODY)))
  })

  test.each([
    ["a missing signature", () => null, "Missing X-Fleetio-Webhook-Signature"],
    ["the wrong secret", () => sign("other", BODY), "Invalid webhook signature"],
    ["a tampered body", () => sign(SECRET, `${BODY} `), "Invalid webhook signature"],
    ["a signature of another length", () => "abc", "Invalid webhook signature"],
  ])("rejects %s", async (_name, signature, message) => {
    const webhook = fleetioEventsWebhook({ credential: SECRET, onEvent: () => {} })

    const error = await Promise.resolve()
      .then(() => webhook.verify?.(verifyCtx(BODY, signature())))
      .catch((caught: unknown) => caught)

    expect(String(error)).toContain(message)
  })

  test("sets no idempotency key, because Sixb answers a repeated key with 202", () => {
    const webhook = fleetioEventsWebhook({ credential: SECRET, onEvent: () => {} })

    expect(webhook.idempotencyKey).toBeUndefined()
  })

  test("passes the delivery to onEvent and answers exactly 200", async () => {
    const received: FleetioEventContext[] = []
    const webhook = fleetioEventsWebhook({
      credential: SECRET,
      onEvent: (context) => {
        received.push(context)
      },
    })

    const parsed = webhook.body.parse?.(JSON.parse(BODY))
    const response = await webhook.handle(handleCtx(parsed))

    expect(response).toEqual({ status: 200 })
    expect(received[0]?.event).toEqual({
      id: 12283768,
      type: "work_order_updated",
      timestamp: "2026-11-05T11:49:21.000-07:00",
      triggeredBy: "sam@example.com",
      payload: { id: 42, number: "1042" },
    })
  })

  test("passes an event it has never heard of through to onEvent", () => {
    const webhook = fleetioEventsWebhook({ credential: SECRET, onEvent: () => {} })

    const parsed = webhook.body.parse?.({ id: 1, event: "brand_new_event", triggered_by: null })

    expect(parsed).toMatchObject({ type: "brand_new_event", triggeredBy: null, payload: {} })
  })

  test("rejects a body that is not a Fleetio delivery", () => {
    const webhook = fleetioEventsWebhook({ credential: SECRET, onEvent: () => {} })

    expect(() => webhook.body.parse?.({ event: "work_order_updated" })).toThrow(
      "Unexpected webhook payload"
    )
  })
})

describe("webhook management", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("manages webhooks and reads delivery history", async () => {
    const calls = recorder([
      json({ id: 1, url: "https://a.example", shared_key: "s" }, { status: 201 }),
      json({ id: 1, enabled: true }),
      empty(),
      page([{ id: 9, status: "failed" }]),
    ])
    const fl = await createTestClient()

    const created = await fl.webhooks.create({ url: "https://a.example", work_order_created: true })
    await fl.webhooks.update(1, { enabled: true })
    await fl.webhooks.delete(1)
    await fl.webhookEvents.list({ filter: { webhook_id: { eq: 1 } } })

    expect(calls.map(route)).toEqual([
      "POST /api/webhooks",
      "PATCH /api/webhooks/1",
      "DELETE /api/webhooks/1",
      "GET /api/webhook_events?filter[webhook_id][eq]=1",
    ])
    expect(created.shared_key).toBe("s")
  })
})
