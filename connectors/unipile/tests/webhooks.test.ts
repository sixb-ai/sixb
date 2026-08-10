import { afterEach, describe, expect, test } from "bun:test"
import { noopLogger } from "@sixb/core"
import type { UnipileEventContext, UnipileWebhookEvent } from "../src"
import { UNIPILE_WEBHOOK_SECRET_HEADER, unipile, unipileEventsWebhook } from "../src"
import { createTestClient, DSN, json, jsonBody, originalFetch, recorder, TOKEN } from "./helpers"

type VerifyContext = Parameters<NonNullable<ReturnType<typeof unipileEventsWebhook>["verify"]>>[0]
type HandleContext = Parameters<ReturnType<typeof unipileEventsWebhook>["handle"]>[0]
type IdempotencyContext = Parameters<
  NonNullable<ReturnType<typeof unipileEventsWebhook>["idempotencyKey"]>
>[0]

afterEach(() => {
  globalThis.fetch = originalFetch
})

function messagePayload() {
  return {
    account_id: "account-1",
    account_type: "LINKEDIN",
    account_info: { type: "LINKEDIN", feature: "classic", user_id: "ACoOwner" },
    event: "message_received",
    chat_id: "chat-1",
    timestamp: "2026-08-10T10:00:00.000Z",
    webhook_name: "Messages",
    message_id: "message-1",
    message: "Hello",
    sender: {
      attendee_id: "attendee-1",
      attendee_name: "Ada Lovelace",
      attendee_provider_id: "ACoAda",
      attendee_profile_url: "https://www.linkedin.com/in/ada",
    },
    attendees: [],
    attachments: [],
  }
}

function handleContext(body: UnipileWebhookEvent): HandleContext {
  return {
    request: new Request("https://app.example/hook", { method: "POST" }),
    body,
    sixb: { id: "demo" },
    logger: noopLogger,
    client: () => Promise.resolve({} as never),
  } as unknown as HandleContext
}

describe("inbound Unipile events", () => {
  test("registers only when onEvent is configured", () => {
    expect(unipile({ dsn: DSN, accessToken: TOKEN }).webhooks).toBeUndefined()
    expect(
      unipile({
        dsn: DSN,
        accessToken: TOKEN,
        webhookSecret: "secret",
        onEvent: () => {},
      }).webhooks
    ).toHaveLength(1)
  })

  test("verifies the shared header and dispatches a normalized message", async () => {
    const received: UnipileEventContext[] = []
    const webhook = unipileEventsWebhook({
      credential: "secret",
      onEvent: (context) => {
        received.push(context)
      },
    })
    const payload = messagePayload()

    webhook.verify?.({
      request: new Request("https://app.example/hook", {
        method: "POST",
        headers: { [UNIPILE_WEBHOOK_SECRET_HEADER]: "secret" },
      }),
      rawBody: new TextEncoder().encode(JSON.stringify(payload)),
    } as unknown as VerifyContext)

    const body = webhook.body.parse(payload)
    const result = await webhook.handle(handleContext(body))

    expect(result).toEqual({ status: 200 })
    expect(received).toHaveLength(1)
    expect(received[0]?.event.kind).toBe("message")
    if (received[0]?.event.kind === "message") {
      expect(received[0].event.sender.attendee_provider_id).toBe("ACoAda")
      expect(received[0].event.account_info?.user_id).toBe("ACoOwner")
    }
    expect(received[0]?.sixb).toEqual({ id: "demo" } as never)
    expect(received[0]?.logger).toBe(noopLogger)
  })

  test("parses account-status deliveries without unsafe de-duplication", () => {
    const webhook = unipileEventsWebhook({ credential: "secret", onEvent: () => {} })
    const body = webhook.body.parse({
      AccountStatus: {
        account_id: "account-1",
        account_type: "LINKEDIN",
        message: "CREDENTIALS",
      },
    })

    expect(body.kind).toBe("account_status")
    if (body.kind === "account_status") {
      expect(body.AccountStatus.message).toBe("CREDENTIALS")
    }
    expect(
      webhook.idempotencyKey?.({
        body,
        request: new Request("https://app.example/hook"),
        rawBody: new Uint8Array(),
      } as IdempotencyContext)
    ).toBeUndefined()
  })

  test("parses new relations and derives a stable idempotency key", () => {
    const webhook = unipileEventsWebhook({ credential: "secret", onEvent: () => {} })
    const body = webhook.body.parse({
      event: "new_relation",
      account_id: "account-1",
      account_type: "LINKEDIN",
      user_full_name: "Ada Lovelace",
      user_provider_id: "ACoAda",
      user_public_identifier: "ada",
      user_profile_url: "https://www.linkedin.com/in/ada",
    })

    expect(body.kind).toBe("new_relation")
    expect(
      webhook.idempotencyKey?.({
        body,
        request: new Request("https://app.example/hook"),
        rawBody: new Uint8Array(),
      } as IdempotencyContext)
    ).toBe("new_relation:account-1:ACoAda")
  })

  test("rejects missing and invalid shared secrets", () => {
    const webhook = unipileEventsWebhook({ credential: "secret", onEvent: () => {} })

    expect(() =>
      webhook.verify?.({
        request: new Request("https://app.example/hook", { method: "POST" }),
        rawBody: new Uint8Array(),
      } as unknown as VerifyContext)
    ).toThrow(`Missing ${UNIPILE_WEBHOOK_SECRET_HEADER}`)

    expect(() =>
      webhook.verify?.({
        request: new Request("https://app.example/hook", {
          method: "POST",
          headers: { [UNIPILE_WEBHOOK_SECRET_HEADER]: "wrong" },
        }),
        rawBody: new Uint8Array(),
      } as unknown as VerifyContext)
    ).toThrow("Invalid webhook shared secret")
  })

  test("rejects unknown event payloads", () => {
    const webhook = unipileEventsWebhook({ credential: "secret", onEvent: () => {} })
    expect(() => webhook.body.parse({ event: "not_supported" })).toThrow(
      "Unexpected webhook payload"
    )
  })
})

describe("webhook verification policy", () => {
  test("requires a credential or an explicit unverified opt-in", () => {
    // @ts-expect-error - neither `credential` nor `allowUnverified`
    const missing: Parameters<typeof unipileEventsWebhook>[0] = { onEvent: () => {} }
    expect(() => unipileEventsWebhook(missing)).toThrow(UNIPILE_WEBHOOK_SECRET_HEADER)

    expect(() => unipile({ dsn: DSN, accessToken: TOKEN, onEvent: () => {} })).toThrow(
      "webhookSecret"
    )
  })

  test("warns once when unverified delivery is explicitly accepted", () => {
    const warnings = captureWarnings(() =>
      unipileEventsWebhook({ allowUnverified: true, onEvent: () => {} })
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("accepts unverified requests")
  })
})

describe("remote webhook management", () => {
  test("create injects and replaces the connector's secret header", async () => {
    const calls = recorder([json({ object: "WebhookCreated", webhook_id: "webhook-1" })])
    const client = await createTestClient({ webhookSecret: "secret" })

    const created = await client.webhooks.create({
      source: "messaging",
      request_url: "https://app.example/api/webhooks/unipile/events",
      events: ["message_received"],
      headers: [{ key: "x-sixb-unipile-secret", value: "wrong" }],
    })

    expect(created.webhook_id).toBe("webhook-1")
    const payload = jsonBody(calls[0] as NonNullable<(typeof calls)[number]>)
    expect(payload.format).toBe("json")
    expect(payload.headers).toEqual([
      { key: "Content-Type", value: "application/json" },
      { key: UNIPILE_WEBHOOK_SECRET_HEADER, value: "secret" },
    ])
  })

  test("account-status registrations preserve explicit lifecycle events", async () => {
    const calls = recorder([json({ object: "WebhookCreated", webhook_id: "webhook-1" })])
    const client = await createTestClient()

    await client.webhooks.create({
      source: "account_status",
      request_url: "https://app.example/api/webhooks/unipile/events",
      events: ["CONNECTING", "OK", "STOPPED", "CREDENTIALS"],
    })

    expect(jsonBody(calls[0] as NonNullable<(typeof calls)[number]>).events).toEqual([
      "CONNECTING",
      "OK",
      "STOPPED",
      "CREDENTIALS",
    ])
  })

  test("listAll and delete use the documented endpoints", async () => {
    const webhook = {
      object: "Webhook",
      id: "webhook-1",
      request_url: "https://app.example/hook",
      enabled: true,
    }
    const calls = recorder([
      json({ object: "WebhookList", items: [webhook], cursor: "webhook-next" }),
      json({ object: "WebhookList", items: [], cursor: null }),
      json({ object: "WebhookDeleted" }),
    ])
    const client = await createTestClient()

    const webhooks = []
    for await (const item of client.webhooks.listAll({ limit: 10 })) {
      webhooks.push(item)
    }
    await client.webhooks.delete("webhook/one")

    expect(webhooks).toHaveLength(1)
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/api/v1/webhooks")
    expect(new URL(calls[2]?.url ?? "").pathname).toBe("/api/v1/webhooks/webhook%2Fone")
    expect(new URL(calls[1]?.url ?? "").searchParams.get("cursor")).toBe("webhook-next")
    expect(calls[2]?.method).toBe("DELETE")
  })
})

function captureWarnings(run: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "))
  try {
    run()
  } finally {
    console.warn = original
  }
  return warnings
}
