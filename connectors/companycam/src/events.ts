import { createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookDefinition } from "@sixb/core"
import { defineWebhook, warnUnverifiedWebhook } from "@sixb/core"
import type { CompanyCamClient } from "./client"
import type { CompanyCamEventHandler, CompanyCamWebhookEvent } from "./types"

interface CompanyCamEventsWebhookOptions {
  readonly secret?: string
  readonly onEvent: CompanyCamEventHandler
}

/**
 * Inbound webhook for CompanyCam events.
 *
 * CompanyCam delivers every subscribed event to one URL, so this registers a
 * single route. When a secret is set it verifies the `X-CompanyCam-Signature`
 * HMAC-SHA1 (base64) over the raw body, forwards the parsed event to `onEvent`,
 * and always responds with exactly `200` (CompanyCam retries / disables the hook
 * on any other status).
 */
export function companyCamEventsWebhook(
  options: CompanyCamEventsWebhookOptions
): WebhookDefinition<unknown, CompanyCamClient> {
  if (!options.secret) {
    warnUnverifiedWebhook({
      connector: "SixbCompanyCam",
      header: "X-CompanyCam-Signature",
      secretOption: "`secret` on companyCamEventsWebhook",
    })
  }

  return defineWebhook("events")
    .post()
    .json()
    .verify(({ request, rawBody }) => {
      if (!options.secret) {
        return
      }
      verifySignature(options.secret, rawBody, request.headers.get("x-companycam-signature"))
    })
    .handle<CompanyCamClient>(async ({ body, sixb, logger, client }) => {
      await options.onEvent({ event: toEvent(body), sixb, logger, client })
      return { status: 200 }
    })
}

function toEvent(body: unknown): CompanyCamWebhookEvent {
  if (!isRecord(body) || typeof body.event_type !== "string") {
    throw new Error("[SixbCompanyCam] Unexpected webhook payload.")
  }
  return {
    type: body.event_type,
    createdAt: typeof body.created_at === "number" ? body.created_at : 0,
    webhookId: typeof body.webhook_id === "number" ? body.webhook_id : 0,
    payload: isRecord(body.payload) ? body.payload : {},
  }
}

function verifySignature(secret: string, rawBody: Uint8Array, signature: string | null): void {
  if (!signature) {
    throw new Error("[SixbCompanyCam] Missing X-CompanyCam-Signature header.")
  }

  const expected = createHmac("sha1", secret).update(rawBody).digest("base64")
  const received = Buffer.from(signature)
  const computed = Buffer.from(expected)

  if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
    throw new Error("[SixbCompanyCam] Invalid webhook signature.")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
