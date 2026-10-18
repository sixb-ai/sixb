import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { noopLogger } from "@sixb/core"
import type { MercuryEvent, MercuryEventContext } from "../src"
import { mercury, mercuryEventsWebhook } from "../src"
import { TOKEN } from "./helpers"

type VerifyCtx = Parameters<NonNullable<ReturnType<typeof mercuryEventsWebhook>["verify"]>>[0]
type HandleCtx = Parameters<ReturnType<typeof mercuryEventsWebhook>["handle"]>[0]
type IdempotencyCtx = Parameters<
  NonNullable<ReturnType<typeof mercuryEventsWebhook>["idempotencyKey"]>
>[0]

const SECRET = "whsec_test"

const EVENT: MercuryEvent = {
  id: "bfa85eaa-afab-11f0-8fea-17d650f2306e",
  resourceType: "transaction",
  resourceId: "1d3042b6-af63-11f0-89d2-3503f2fcfef7",
  operationType: "update",
  resourceVersion: 2,
  occurredAt: "2026-07-26T00:00:00.000000Z",
  changedPaths: ["status", "postedAt"],
  mergePatch: { status: "sent", postedAt: "2026-07-26T00:00:00.000000+00:00" },
  previousValues: { status: "pending", postedAt: null },
}

/** Builds the `Mercury-Signature` header: `t=<unix seconds>,v1=<hex HMAC-SHA256>`. */
function sign(secret: string, body: string, atMs = Date.now()): string {
  const timestamp = Math.floor(atMs / 1000)
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")
  return `t=${timestamp},v1=${signature}`
}

function verifyCtx(body: string, signature: string | null): VerifyCtx {
  return {
    request: new Request("https://app.example/api/webhooks/mercury/events", {
      method: "POST",
      headers: signature ? { "mercury-signature": signature } : {},
    }),
    rawBody: new TextEncoder().encode(body),
  } as unknown as VerifyCtx
}

describe("mercury events webhook", () => {
  const body = JSON.stringify(EVENT)
  const tampered = JSON.stringify({ ...EVENT, resourceId: "attacker-controlled" })
  const sixMinutesAgo = Date.now() - 6 * 60 * 1000

  test("registers the events route only when onEvent is set, alongside any extra webhooks", () => {
    expect(mercury({ accessToken: TOKEN }).webhooks).toBeUndefined()
    expect(
      mercury({ accessToken: TOKEN, webhookAllowUnverified: true, onEvent: () => {} }).webhooks
    ).toHaveLength(1)

    const connector = mercury({
      accessToken: TOKEN,
      webhookAllowUnverified: true,
      onEvent: () => {},
      webhooks: [mercuryEventsWebhook({ allowUnverified: true, onEvent: () => {} }) as never],
    })
    expect(connector.webhooks).toHaveLength(2)
  })

  test("verifies the signature, dispatches the event, and responds 200", async () => {
    const received: MercuryEventContext[] = []
    const webhook = mercuryEventsWebhook({
      credential: SECRET,
      onEvent: (context) => {
        received.push(context)
      },
    })
    const sixb = { id: "demo" }
    const client = () => Promise.resolve({} as never)

    webhook.verify?.(verifyCtx(body, sign(SECRET, body)))

    const result = await webhook.handle({
      request: new Request("https://app.example/hook", { method: "POST" }),
      body: webhook.body.parse(JSON.parse(body)),
      sixb,
      logger: noopLogger,
      client,
    } as unknown as HandleCtx)

    expect(result).toEqual({ status: 200 })
    expect(received).toHaveLength(1)
    expect(received[0]?.event.id).toBe(EVENT.id)
    expect(received[0]?.event.changedPaths).toEqual(["status", "postedAt"])
    expect(received[0]?.event.mergePatch.status).toBe("sent")
    expect(received[0]?.event.previousValues?.status).toBe("pending")
    expect(received[0]?.client).toBe(client)
  })

  test.each([
    [
      "a tampered body under a valid-looking signature",
      tampered,
      sign(SECRET, body),
      "Invalid webhook signature",
    ],
    [
      "a signature produced with the wrong secret",
      body,
      sign("whsec_other", body),
      "Invalid webhook signature",
    ],
    // The replay window.
    ["a stale timestamp", body, sign(SECRET, body, sixMinutesAgo), "outside the allowed window"],
    ["a missing signature header", body, null, "Missing Mercury-Signature"],
    ["a header without a timestamp", body, "v1=deadbeef", "Malformed Mercury-Signature header"],
    [
      "a non-numeric timestamp",
      body,
      "t=notanumber,v1=deadbeef",
      "Malformed Mercury-Signature timestamp",
    ],
  ])("rejects %s", (_name, delivered, signature, message) => {
    const webhook = mercuryEventsWebhook({ credential: SECRET, onEvent: () => {} })

    expect(() => webhook.verify?.(verifyCtx(delivered, signature))).toThrow(message)
  })

  test("accepts a stale timestamp when the tolerance is widened", () => {
    const webhook = mercuryEventsWebhook({
      credential: SECRET,
      onEvent: () => {},
      toleranceMs: 60 * 60 * 1000,
    })

    expect(() => webhook.verify?.(verifyCtx(body, sign(SECRET, body, sixMinutesAgo)))).not.toThrow()
  })

  test("skips verification when no secret is configured", () => {
    const webhook = mercuryEventsWebhook({ allowUnverified: true, onEvent: () => {} })

    expect(() => webhook.verify?.(verifyCtx("{}", null))).not.toThrow()
  })

  test("reports the event id as the idempotency key for at-least-once delivery", () => {
    const webhook = mercuryEventsWebhook({ allowUnverified: true, onEvent: () => {} })

    expect(webhook.idempotencyKey?.({ body: EVENT } as unknown as IdempotencyCtx)).toBe(EVENT.id)
  })

  test("parses a balance event and defaults its optional fields", () => {
    const webhook = mercuryEventsWebhook({ allowUnverified: true, onEvent: () => {} })

    const parsed = webhook.body.parse({
      id: "ev-1",
      resourceType: "checkingAccount",
      resourceId: "acct-1",
      operationType: "update",
      occurredAt: "2026-07-26T00:00:00Z",
      mergePatch: { availableBalance: 100.25 },
    })

    expect(parsed.resourceVersion).toBe(1)
    expect(parsed.changedPaths).toEqual([])
    expect(parsed.previousValues).toBeNull()
  })

  test("rejects payloads that are not Mercury events", () => {
    const webhook = mercuryEventsWebhook({ allowUnverified: true, onEvent: () => {} })

    expect(() => webhook.body.parse({})).toThrow("Unexpected webhook payload")
    expect(() => webhook.body.parse({ id: "ev-1", resourceType: "spaceship" })).toThrow(
      "Unknown webhook resourceType"
    )
    expect(() =>
      webhook.body.parse({ id: "ev-1", resourceType: "transaction", operationType: "explode" })
    ).toThrow("Unknown webhook operationType")
  })

  test("rejects a non-positive tolerance at construction", () => {
    expect(() =>
      mercuryEventsWebhook({ allowUnverified: true, onEvent: () => {}, toleranceMs: 0 })
    ).toThrow("webhookToleranceMs must be a positive finite number")
  })
})

describe("mercuryEventsWebhook without a secret", () => {
  test("cannot be written without a secret or an explicit opt-in", () => {
    // The first guarantee is the type: `WebhookVerification` has no shape that carries
    // neither, so this line does not compile.
    // @ts-expect-error - neither `credential` nor `allowUnverified`
    const missing: Parameters<typeof mercuryEventsWebhook>[0] = { onEvent: () => {} }

    // The second is the throw, for the caller the type cannot reach — plain JS, or one who
    // widened to `any`. `if (!options.secret) return` inside `.verify()` used to accept
    // anything that reached the route, and for a while it only warned, which a startup log
    // buries. Now `createSixb()` fails and the API role never starts.
    expect(() => mercuryEventsWebhook(missing)).toThrow(/Mercury-Signature/)
  })

  test("accepts unverified deliveries when asked to, and says so only then", () => {
    const warnings = captureWarnings(() =>
      mercuryEventsWebhook({ allowUnverified: true, onEvent: () => {} })
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("Mercury-Signature")
    expect(warnings[0]).toContain("accepts unverified requests")

    // A configured secret stays quiet.
    expect(
      captureWarnings(() => mercuryEventsWebhook({ credential: SECRET, onEvent: () => {} }))
    ).toEqual([])
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
