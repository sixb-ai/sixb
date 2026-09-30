import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { defineWebhook, type WebhookDefinition } from "@sixb/core"
import { resolveApiKey } from "./api-key"
import { job } from "./response"
import type {
  FullEnrichApiKeyResolver,
  FullEnrichClient,
  FullEnrichEnrichment,
  FullEnrichReverseEmailLookup,
  FullEnrichWebhookHandler,
} from "./types"

/**
 * Inbound result deliveries for jobs started with a `webhook_url` or
 * `webhook_events.contact_finished` pointing at `/api/webhooks/<connector id>/<webhook id>`.
 *
 * FullEnrich signs each body with `X-Signature-SHA1`, an HMAC-SHA1 hex digest keyed with the
 * API key, so every delivery is verified with the key the connector already holds. Failed
 * deliveries are retried up to five times with the same body; its digest is the idempotency key.
 */
export function createFullEnrichWebhooks(options: {
  readonly apiKey: FullEnrichApiKeyResolver
  readonly onEnrichmentResult?: FullEnrichWebhookHandler<FullEnrichEnrichment>
  readonly onReverseEmailLookupResult?: FullEnrichWebhookHandler<FullEnrichReverseEmailLookup>
}): WebhookDefinition<unknown, FullEnrichClient>[] {
  const webhooks: WebhookDefinition<unknown, FullEnrichClient>[] = []
  if (options.onEnrichmentResult) {
    webhooks.push(
      resultWebhook("enrichments", "enrichment webhook", options.apiKey, options.onEnrichmentResult)
    )
  }
  if (options.onReverseEmailLookupResult) {
    webhooks.push(
      resultWebhook(
        "reverse-email-lookups",
        "reverse email lookup webhook",
        options.apiKey,
        options.onReverseEmailLookupResult
      )
    )
  }
  return webhooks
}

function resultWebhook<TResult>(
  id: string,
  operation: string,
  apiKey: FullEnrichApiKeyResolver,
  onResult: FullEnrichWebhookHandler<TResult>
): WebhookDefinition<unknown, FullEnrichClient> {
  return defineWebhook(id)
    .post()
    .json({ parse: (value: unknown) => job<TResult>(operation, value) })
    .verify(async ({ request, rawBody }) => {
      verifySignature(await resolveApiKey(apiKey), rawBody, request.headers.get("x-signature-sha1"))
    })
    .idempotencyKey(({ rawBody }) => createHash("sha256").update(rawBody).digest("hex"))
    .handle<FullEnrichClient>(async ({ body, sixb, logger, client }) => {
      await onResult({ result: body, sixb, logger, client })
      return { status: 200 }
    })
}

function verifySignature(apiKey: string, rawBody: Uint8Array, signature: string | null): void {
  if (!signature) throw new Error("[SixbFullEnrich] Missing X-Signature-SHA1 header.")

  const expected = Buffer.from(createHmac("sha1", apiKey).update(rawBody).digest("hex"))
  const received = Buffer.from(signature.trim().toLowerCase())
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("[SixbFullEnrich] Invalid webhook signature.")
  }
}
