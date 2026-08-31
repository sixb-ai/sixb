import { describe, expect, test } from "bun:test"
import { noopLogger } from "@sixb/core"
import Stripe from "stripe"
import type { StripeEvent, StripeEventContext } from "../src"
import { stripe, stripeEventsWebhook } from "../src"
import { API_KEY } from "./helpers"

type VerifyContext = Parameters<NonNullable<ReturnType<typeof stripeEventsWebhook>["verify"]>>[0]
type HandleContext = Parameters<ReturnType<typeof stripeEventsWebhook>["handle"]>[0]
type IdempotencyContext = Parameters<
  NonNullable<ReturnType<typeof stripeEventsWebhook>["idempotencyKey"]>
>[0]

const SECRET = "whsec_sixb_test"

const EVENT: StripeEvent = {
  id: "evt_1",
  object: "event",
  api_version: "2026-03-25.dahlia",
  created: 1_788_000_000,
  data: {
    object: {
      id: "cus_1",
      object: "customer",
      balance: 0,
      created: 1_788_000_000,
      default_source: null,
      description: null,
      email: "ada@example.com",
      invoice_settings: {
        custom_fields: null,
        default_payment_method: null,
        footer: null,
        rendering_options: null,
      },
      livemode: false,
      metadata: {},
      shipping: null,
    },
  },
  livemode: false,
  pending_webhooks: 0,
  request: { id: "req_1", idempotency_key: null },
  type: "customer.created",
}

function verifyContext(body: string, signature: string | null): VerifyContext {
  return {
    request: new Request("https://app.example/api/webhooks/stripe/events", {
      method: "POST",
      headers: signature ? { "stripe-signature": signature } : {},
    }),
    rawBody: new TextEncoder().encode(body),
  } as unknown as VerifyContext
}

describe("stripe events webhook", () => {
  test("registers only when onEvent is configured", () => {
    expect(stripe({ apiKey: API_KEY }).webhooks).toBeUndefined()
    expect(
      stripe({ apiKey: API_KEY, webhookAllowUnverified: true, onEvent: () => {} }).webhooks
    ).toHaveLength(1)
  })

  test("verifies the raw payload with Stripe's SDK and dispatches the parsed event", async () => {
    const received: StripeEventContext[] = []
    const webhook = stripeEventsWebhook({
      credential: SECRET,
      onEvent: (context) => {
        received.push(context)
      },
    })
    const body = JSON.stringify(EVENT)
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: body,
      secret: SECRET,
    })
    const client = () => Promise.resolve({} as never)

    await webhook.verify?.(verifyContext(body, signature))
    const result = await webhook.handle({
      request: new Request("https://app.example/hook", { method: "POST" }),
      body: webhook.body.parse(JSON.parse(body)),
      sixb: { id: "demo" },
      logger: noopLogger,
      client,
    } as unknown as HandleContext)

    expect(result).toEqual({ status: 200 })
    expect(received).toHaveLength(1)
    expect(received[0]?.event.id).toBe("evt_1")
    expect(received[0]?.event.type).toBe("customer.created")
    expect(received[0]?.client).toBe(client)
  })

  test("rejects tampered, stale, and unsigned deliveries", async () => {
    const webhook = stripeEventsWebhook({ credential: SECRET, onEvent: () => {} })
    const body = JSON.stringify(EVENT)
    const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: body,
      secret: SECRET,
    })
    const staleSignature = await Stripe.webhooks.generateTestHeaderStringAsync({
      payload: body,
      secret: SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 6 * 60,
    })

    await expect(
      webhook.verify?.(verifyContext(JSON.stringify({ ...EVENT, id: "evt_tampered" }), signature))
    ).rejects.toThrow("signature")
    await expect(webhook.verify?.(verifyContext(body, staleSignature))).rejects.toThrow("tolerance")
    await expect(webhook.verify?.(verifyContext(body, null))).rejects.toThrow(
      "Missing Stripe-Signature"
    )
  })

  test("reports the event id as the delivery idempotency key", () => {
    const webhook = stripeEventsWebhook({ allowUnverified: true, onEvent: () => {} })

    expect(webhook.idempotencyKey?.({ body: EVENT } as unknown as IdempotencyContext)).toBe("evt_1")
  })

  test("rejects malformed event payloads", () => {
    const webhook = stripeEventsWebhook({ allowUnverified: true, onEvent: () => {} })

    expect(() => webhook.body.parse({})).toThrow("Unexpected webhook payload")
    expect(() => webhook.body.parse({ id: "evt_1", object: "event" })).toThrow(
      "missing type or data"
    )
  })

  test("requires a secret or an explicit unverified opt-in", () => {
    // @ts-expect-error - neither `credential` nor `allowUnverified`
    const missing: Parameters<typeof stripeEventsWebhook>[0] = { onEvent: () => {} }

    expect(() => stripeEventsWebhook(missing)).toThrow(/Stripe-Signature/)
  })

  test("validates the webhook tolerance", () => {
    expect(() =>
      stripeEventsWebhook({ allowUnverified: true, onEvent: () => {}, toleranceMs: 0 })
    ).toThrow("webhookToleranceMs must be a positive finite number")
  })
})
