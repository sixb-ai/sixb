import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import type { CompanyCamEventContext } from "../src"
import { companyCamEventsWebhook, companycam } from "../src"

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof companyCamEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof companyCamEventsWebhook>["handle"]>[0]

const sign = (secret: string, body: string): string =>
  createHmac("sha1", secret).update(body).digest("base64")

describe("companycam events webhook", () => {
  test("registers only when onEvent is set", () => {
    expect(companycam({ token: "t" }).webhooks).toBeUndefined()
    expect(companycam({ token: "t", onEvent: () => {} }).webhooks).toHaveLength(1)
  })

  test("verifies the signature, dispatches the event, and responds 200", async () => {
    const received: CompanyCamEventContext[] = []
    const webhook = companyCamEventsWebhook({
      secret: "s",
      onEvent: (context) => {
        received.push(context)
      },
    })
    const body = JSON.stringify({
      event_type: "project.created",
      created_at: 99,
      webhook_id: 7,
      payload: { id: "p1" },
    })
    const sixb = { id: "demo" }
    const client = () => Promise.resolve({} as never)

    webhook.verify?.({
      request: new Request("https://x/hook", {
        method: "POST",
        headers: { "x-companycam-signature": sign("s", body) },
      }),
      rawBody: new TextEncoder().encode(body),
    } as unknown as VerifyCtx)

    const result = await webhook.handle({
      request: new Request("https://x/hook", { method: "POST" }),
      body: JSON.parse(body),
      sixb,
      client,
    } as unknown as HandleCtx)

    expect(result).toEqual({ status: 200 })
    expect(received).toHaveLength(1)
    expect(received[0]?.event.type).toBe("project.created")
    expect(received[0]?.event.createdAt).toBe(99)
    expect(received[0]?.event.webhookId).toBe(7)
    expect(received[0]?.event.payload).toEqual({ id: "p1" })
    expect(received[0]?.sixb).toBe(sixb as never)
    expect(received[0]?.client).toBe(client)
  })

  test("rejects an invalid signature", () => {
    const webhook = companyCamEventsWebhook({ secret: "s", onEvent: () => {} })
    expect(() =>
      webhook.verify?.({
        request: new Request("https://x/hook", {
          method: "POST",
          headers: { "x-companycam-signature": "bm90LXZhbGlk" },
        }),
        rawBody: new TextEncoder().encode("{}"),
      } as unknown as VerifyCtx)
    ).toThrow("Invalid webhook signature")
  })

  test("skips verification when no secret is configured", () => {
    const webhook = companyCamEventsWebhook({ onEvent: () => {} })
    expect(() =>
      webhook.verify?.({
        request: new Request("https://x/hook", { method: "POST" }),
        rawBody: new TextEncoder().encode("{}"),
      } as unknown as VerifyCtx)
    ).not.toThrow()
  })
})
