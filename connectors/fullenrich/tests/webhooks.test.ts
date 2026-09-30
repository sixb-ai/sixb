import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { noopLogger, type WebhookDefinition } from "@sixb/core"
import type { FullEnrichClient, FullEnrichEnrichment, FullEnrichWebhookContext } from "../src"
import { fullenrich } from "../src"
import { API_KEY, ENRICHMENT } from "./helpers"

type Webhook = WebhookDefinition<unknown, FullEnrichClient>
type VerifyCtx = Parameters<NonNullable<Webhook["verify"]>>[0]
type HandleCtx = Parameters<Webhook["handle"]>[0]
type IdempotencyCtx = Parameters<NonNullable<Webhook["idempotencyKey"]>>[0]

function sign(key: string, body: string): string {
  return createHmac("sha1", key).update(body).digest("hex")
}

function verifyCtx(body: string, signature: string | null): VerifyCtx {
  return {
    request: new Request("https://app.example/api/webhooks/fullenrich/enrichments", {
      method: "POST",
      headers: signature ? { "x-signature-sha1": signature } : {},
    }),
    rawBody: new TextEncoder().encode(body),
  } as unknown as VerifyCtx
}

function enrichmentWebhook(
  onEnrichmentResult: (context: FullEnrichWebhookContext<FullEnrichEnrichment>) => void = () => {},
  apiKey: string | (() => Promise<string>) = API_KEY
): Webhook {
  const webhook = fullenrich({ apiKey, onEnrichmentResult }).webhooks?.[0]
  if (!webhook) throw new Error("expected the enrichment webhook")
  return webhook as Webhook
}

describe("FullEnrich result webhooks", () => {
  test("registers one route per result handler", () => {
    expect(fullenrich({ apiKey: API_KEY }).webhooks).toBeUndefined()
    const connector = fullenrich({
      apiKey: API_KEY,
      onEnrichmentResult: () => {},
      onReverseEmailLookupResult: () => {},
    })
    expect(connector.webhooks?.map((webhook) => webhook.id)).toEqual([
      "enrichments",
      "reverse-email-lookups",
    ])
  })

  test("verifies the API-key HMAC, dispatches the result, and responds 200", async () => {
    const received: FullEnrichWebhookContext<FullEnrichEnrichment>[] = []
    const webhook = enrichmentWebhook((context) => {
      received.push(context)
    })
    const body = JSON.stringify(ENRICHMENT)
    const client = () => Promise.resolve({} as FullEnrichClient)

    await webhook.verify?.(verifyCtx(body, sign(API_KEY, body)))
    const result = await webhook.handle({
      body: webhook.body.parse(JSON.parse(body)),
      sixb: { id: "demo" },
      logger: noopLogger,
      client,
    } as unknown as HandleCtx)

    expect(result).toEqual({ status: 200 })
    expect(received).toHaveLength(1)
    expect(received[0]?.result.id).toBe(ENRICHMENT.id)
    expect(received[0]?.result.data?.[0]?.contact_info?.most_probable_work_email?.email).toBe(
      "john.snow@example.com"
    )
    expect(received[0]?.client).toBe(client)
  })

  test("resolves a key resolver when verifying", async () => {
    const webhook = enrichmentWebhook(
      () => {},
      async () => "rotated_key"
    )
    const body = JSON.stringify(ENRICHMENT)

    await expect(
      Promise.resolve(webhook.verify?.(verifyCtx(body, sign("rotated_key", body))))
    ).resolves.toBeUndefined()
    await expect(
      Promise.resolve(webhook.verify?.(verifyCtx(body, sign(API_KEY, body))))
    ).rejects.toThrow("Invalid webhook signature")
  })

  // Guard proof: return early from verifySignature; every rejection below stops throwing.
  test("rejects missing, tampered, and wrong-key signatures", async () => {
    const webhook = enrichmentWebhook()
    const body = JSON.stringify(ENRICHMENT)
    const tampered = JSON.stringify({ ...ENRICHMENT, status: "CANCELED" })

    await expect(Promise.resolve(webhook.verify?.(verifyCtx(body, null)))).rejects.toThrow(
      "Missing X-Signature-SHA1 header"
    )
    await expect(
      Promise.resolve(webhook.verify?.(verifyCtx(tampered, sign(API_KEY, body))))
    ).rejects.toThrow("Invalid webhook signature")
    await expect(
      Promise.resolve(webhook.verify?.(verifyCtx(body, sign("other_key", body))))
    ).rejects.toThrow("Invalid webhook signature")
  })

  test("deduplicates retried deliveries by body and rejects payloads without a job", async () => {
    const webhook = enrichmentWebhook()
    const body = new TextEncoder().encode(JSON.stringify(ENRICHMENT))
    const key = (rawBody: Uint8Array) =>
      webhook.idempotencyKey?.({ rawBody } as unknown as IdempotencyCtx)

    expect(key(body)).toBe(key(new Uint8Array(body)))
    expect(key(body)).not.toBe(key(new TextEncoder().encode("{}")))
    expect(() => webhook.body.parse({ status: "FINISHED" })).toThrow(
      "id must be a non-empty string"
    )
  })
})
