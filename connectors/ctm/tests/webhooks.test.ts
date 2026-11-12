import { afterEach, describe, expect, test } from "bun:test"
import { noopLogger } from "@sixb/core"
import type { CtmEventContext } from "../src"
import { ctm, ctmEventsWebhook } from "../src"
import { callRecord } from "./helpers"

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof ctmEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof ctmEventsWebhook>["handle"]>[0]

const AUTH = { username: "ctm", password: "s3cret" }
const URL_BASE = "https://app.example/api/webhooks/ctm/events"
const originalWarn = console.warn

afterEach(() => {
  console.warn = originalWarn
})

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

function verifyCtx(authorization: string | null): VerifyCtx {
  return {
    request: new Request(URL_BASE, {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }),
    rawBody: new Uint8Array(),
  } as unknown as VerifyCtx
}

function handleCtx(body: unknown, url = URL_BASE): HandleCtx {
  return {
    body,
    request: new Request(url, { method: "POST" }),
    sixb: {},
    logger: noopLogger,
    client: async () => ({}),
  } as unknown as HandleCtx
}

describe("ctm events webhook", () => {
  test("registers the route only when onEvent is set", () => {
    const base = { accessKey: "key", secretKey: "secret" }

    expect(ctm(base).webhooks).toBeUndefined()
    expect(ctm({ ...base, webhookAuth: AUTH, onEvent: () => {} }).webhooks).toHaveLength(1)
  })

  test("refuses to build without credentials unless told to, and warns when told to", () => {
    const warnings: unknown[] = []
    console.warn = (message: unknown) => warnings.push(message)
    const base = { accessKey: "key", secretKey: "secret", onEvent: () => {} }

    expect(() => ctm(base)).toThrow("webhookAuth")
    expect(ctm({ ...base, webhookAllowUnverified: true }).webhooks).toHaveLength(1)
    expect(String(warnings[0])).toContain("webhookAllowUnverified")
  })

  test("refuses credentials with an empty field, as an unset variable would give", () => {
    const options = { onEvent: () => {}, credential: { username: "ctm", password: "" } }

    expect(() => ctmEventsWebhook(options)).toThrow("non-empty username and password")
  })

  test("accepts the basic auth set on the webhook in CTM", async () => {
    const webhook = ctmEventsWebhook({ credential: AUTH, onEvent: () => {} })

    await webhook.verify?.(verifyCtx(basic("ctm", "s3cret")))
  })

  test.each([
    ["a missing header", null, "Missing webhook basic auth"],
    ["another scheme", "Bearer s3cret", "Missing webhook basic auth"],
    ["the wrong password", basic("ctm", "guess"), "Invalid webhook basic auth"],
    ["the wrong username", basic("other", "s3cret"), "Invalid webhook basic auth"],
  ])("rejects %s", async (_name, header, message) => {
    const webhook = ctmEventsWebhook({ credential: AUTH, onEvent: () => {} })

    const error = await Promise.resolve()
      .then(() => webhook.verify?.(verifyCtx(header)))
      .catch((caught: unknown) => caught)

    expect(String(error)).toContain(message)
  })

  test("sets no idempotency key, because an update webhook resends the same activity", () => {
    const webhook = ctmEventsWebhook({ credential: AUTH, onEvent: () => {} })

    expect(webhook.idempotencyKey).toBeUndefined()
  })

  test("passes the activity and the URL's trigger to onEvent and answers 200", async () => {
    const received: CtmEventContext[] = []
    const webhook = ctmEventsWebhook({
      credential: AUTH,
      onEvent: (context) => {
        received.push(context)
      },
    })

    const activity = webhook.body.parse?.(callRecord(42))
    const response = await webhook.handle(handleCtx(activity, `${URL_BASE}?trigger=end_delayed`))
    await webhook.handle(handleCtx(activity))

    expect(response).toEqual({ status: 200 })
    expect(received[0]?.event.trigger).toBe("end_delayed")
    expect(received[0]?.event.activity.id).toBe(42)
    expect(received[1]?.event.trigger).toBeNull()
  })

  test("rejects a body that is not an activity, pointing at hooktype", () => {
    const webhook = ctmEventsWebhook({ credential: AUTH, onEvent: () => {} })

    expect(() => webhook.body.parse?.({ url: "https://ctm/ref/1" })).toThrow('hooktype: "call"')
    expect(() => webhook.body.parse?.([callRecord(1)])).toThrow("Unexpected webhook payload")
  })
})
