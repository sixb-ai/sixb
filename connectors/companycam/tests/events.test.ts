import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { noopLogger } from "@sixb/core"
import type { CompanyCamEventContext } from "../src"
import { companyCamEventsWebhook, companycam } from "../src"

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof companyCamEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof companyCamEventsWebhook>["handle"]>[0]

const sign = (secret: string, body: string): string =>
  createHmac("sha1", secret).update(body).digest("base64")

describe("companycam events webhook", () => {
  test("registers only when onEvent is set", () => {
    expect(companycam({ token: "t" }).webhooks).toBeUndefined()
    expect(
      companycam({ token: "t", webhookAllowUnsigned: true, onEvent: () => {} }).webhooks
    ).toHaveLength(1)
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
      logger: noopLogger,
      client,
    } as unknown as HandleCtx)

    expect(result).toEqual({ status: 200 })
    expect(received).toHaveLength(1)
    expect(received[0]?.event.type).toBe("project.created")
    expect(received[0]?.event.createdAt).toBe(99)
    expect(received[0]?.event.webhookId).toBe(7)
    expect(received[0]?.event.payload).toEqual({ id: "p1" })
    expect(received[0]?.sixb).toBe(sixb as never)
    expect(received[0]?.logger).toBe(noopLogger)
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
    const webhook = companyCamEventsWebhook({ allowUnsigned: true, onEvent: () => {} })
    expect(() =>
      webhook.verify?.({
        request: new Request("https://x/hook", { method: "POST" }),
        rawBody: new TextEncoder().encode("{}"),
      } as unknown as VerifyCtx)
    ).not.toThrow()
  })
})

describe("companyCamEventsWebhook without a secret", () => {
  test("refuses to define a webhook that would accept unsigned requests", () => {
    // `if (!options.secret) return` inside `.verify()` accepted anything that reached the
    // route. It threw no error and, for a while, only warned — which a startup log buries.
    // The definition now fails, so `createSixb()` fails and the API role never starts.
    expect(() => companyCamEventsWebhook({ onEvent: () => {} })).toThrow(/X-CompanyCam-Signature/)
  })

  test("accepts unsigned deliveries when asked to, and says so", () => {
    const warnings = captureWarnings(() =>
      companyCamEventsWebhook({ allowUnsigned: true, onEvent: () => {} })
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("X-CompanyCam-Signature")
    expect(warnings[0]).toContain("accepts unsigned requests")
  })

  test("stays quiet when a secret is configured", () => {
    const warnings = captureWarnings(() =>
      companyCamEventsWebhook({ secret: "whsec_test", onEvent: () => {} })
    )

    expect(warnings).toEqual([])
  })
})

/** Captures `console.warn` for the duration of one call. */
function captureWarnings(run: () => void): string[] {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }
  try {
    run()
  } finally {
    console.warn = original
  }
  return warnings
}
