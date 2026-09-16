import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { defineConnector, noopLogger } from "@sixb/core"
import { type QuickBooksEventContext, quickbooks, quickbooksEventsWebhook } from "../src"

const token = "verifier-test-token"
const event = {
  specversion: "1.0" as const,
  id: "event-1",
  source: "intuit.app",
  type: "qbo.invoice.updated.v1",
  time: "2026-09-16T12:00:00Z",
  intuitaccountid: "123",
  intuitentityid: "42",
  data: {},
}
const connector = defineConnector(
  "qb",
  quickbooks({ clientId: "id", clientSecret: "secret", environment: "sandbox" })
)
const webhook = {
  id: "events",
  method: "POST",
  route: "/api/webhooks/qb/events",
  bodyFormat: "json",
} as const
function verifyContext(body: string, signature?: string) {
  return {
    connector,
    webhook,
    rawBody: new TextEncoder().encode(body),
    request: new Request("https://example.test/api/webhooks/qb/events", {
      method: "POST",
      headers: signature ? { "intuit-signature": signature } : {},
    }),
  }
}
function sign(body: string) {
  return createHmac("sha256", token).update(body).digest("base64")
}

test("webhook verifies exact raw bytes and rejects malformed, unsigned and altered deliveries", async () => {
  // Removal proof: remove timingSafeEqual verification; the tampered-body assertion fails.
  const hook = quickbooksEventsWebhook({ verifierToken: token, onEvent() {} })
  const body = JSON.stringify([event], null, 2)
  await hook.verify?.(verifyContext(body, sign(body)))
  for (const signature of [undefined, "bad", `${sign(body)},${sign(body)}`, sign("different")]) {
    expect(() => hook.verify?.(verifyContext(body, signature))).toThrow("[SixbQuickBooks]")
  }
  expect(() => hook.verify?.(verifyContext(JSON.stringify([event]), sign(body)))).toThrow(
    "Invalid webhook signature"
  )
  expect(hook.idempotencyKey).toBeUndefined()
})

test("full payload handler controls account lookup, custom responses and duplicate event handling", async () => {
  const received: QuickBooksEventContext[] = []
  const lookups: string[] = []
  const hook = quickbooksEventsWebhook({
    verifierToken: token,
    async onEvent(context) {
      received.push(context)
      for (const item of context.body) await context.connections.forAccount(item.intuitaccountid)
      return { status: 200, headers: { "x-processed": "yes" }, body: "OK" }
    },
  })
  const payload = [event, { ...event, intuitaccountid: "456" }, event]
  const context: QuickBooksEventContext = {
    ...verifyContext(JSON.stringify(payload)),
    body: hook.body.parse(payload),
    logger: noopLogger,
    sixb: {} as never,
    client: async () => {
      throw new Error("top-level client should not be resolved")
    },
    connections: {
      async forAccount(id) {
        lookups.push(id)
        return []
      },
    },
  }
  expect(await hook.handle(context)).toEqual({
    status: 200,
    headers: { "x-processed": "yes" },
    body: "OK",
  })
  expect(received).toHaveLength(1)
  expect(received[0]?.body).toBe(payload)
  expect(lookups).toEqual(["123", "456", "123"])
})

test("webhook awaits handler completion, defaults to HTTP 200 and propagates failures", async () => {
  let finish: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const hook = quickbooksEventsWebhook({ verifierToken: token, onEvent: () => pending })
  const context = {
    ...verifyContext("[]"),
    body: [],
    logger: noopLogger,
    sixb: {} as never,
    connections: {
      async forAccount() {
        return []
      },
    },
    client: async () => {
      throw new Error("unused")
    },
  }
  let completed = false
  const result = Promise.resolve(hook.handle(context)).then((value) => {
    completed = true
    return value
  })
  await Promise.resolve()
  expect(completed).toBe(false)
  finish?.()
  expect(await result).toEqual({ status: 200 })
  const failed = quickbooksEventsWebhook({
    verifierToken: token,
    onEvent() {
      throw new Error("queue unavailable")
    },
  })
  await expect(failed.handle(context)).rejects.toThrow("queue unavailable")
})

test("parser rejects legacy/malformed payloads and retains new event types and extensions", () => {
  const hook = quickbooksEventsWebhook({ verifierToken: token, onEvent() {} })
  for (const payload of [
    { eventNotifications: [] },
    [null],
    [{ ...event, specversion: "0.3" }],
    [{ ...event, source: "" }],
    [{ ...event, intuitaccountid: "../other" }],
  ]) {
    expect(() => hook.body.parse(payload)).toThrow("[SixbQuickBooks]")
  }
  const payload = [{ ...event, type: "qbo.future.created.v2", extension: { a: 1 } }]
  expect(hook.body.parse(payload)).toBe(payload)
})

test("adapter registers the ordinary webhook and optional request identity", () => {
  const options = { clientId: "id", clientSecret: "secret", environment: "sandbox" } as const
  expect(quickbooks(options).webhooks).toBeUndefined()
  expect(() => quickbooksEventsWebhook({ verifierToken: "", onEvent() {} })).toThrow(
    "verifierToken"
  )
  const idempotencyKey = () => "application-delivery-id"
  const hooks = quickbooks({
    ...options,
    webhooks: { verifierToken: token, onEvent() {}, idempotencyKey },
  }).webhooks
  expect(hooks).toHaveLength(1)
  expect(hooks?.[0]?.id).toBe("events")
  expect(hooks?.[0]?.idempotencyKey).toBe(idempotencyKey)
})
