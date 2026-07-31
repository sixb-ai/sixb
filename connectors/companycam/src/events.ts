import { createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookDefinition, WebhookVerification, WebhookVerificationSubject } from "@sixb/core"
import { defineWebhook, resolveWebhookVerification, warnUnverifiedWebhook } from "@sixb/core"
import type { CompanyCamClient } from "./client"
import type { CompanyCamEventHandler, CompanyCamWebhookEvent } from "./types"

export const COMPANYCAM_WEBHOOK: WebhookVerificationSubject = {
  connector: "SixbCompanyCam",
  verifies: "the X-CompanyCam-Signature HMAC",
  credentialOption: "`credential` on `companyCamEventsWebhook()`",
  allowOption: "`allowUnverified: true`",
}

/** The same subject, in the words `companycam()` uses for the same two options. */
export const COMPANYCAM_CONNECTOR_WEBHOOK: WebhookVerificationSubject = {
  ...COMPANYCAM_WEBHOOK,
  credentialOption: "`webhookSecret` on `companycam()`",
  allowOption: "`webhookAllowUnverified: true`",
}

/** Either a signing secret or an explicit decision to do without one. */
type CompanyCamEventsWebhookOptions = WebhookVerification & {
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
  options: CompanyCamEventsWebhookOptions,
  subject: WebhookVerificationSubject = COMPANYCAM_WEBHOOK
): WebhookDefinition<unknown, CompanyCamClient> {
  // Resolved, not just warned about: the union makes this unreachable from TypeScript,
  // and a caller without types still gets the refusal rather than an open route.
  warnUnverifiedWebhook(subject, resolveWebhookVerification(subject, options))

  return defineWebhook("events")
    .post()
    .json()
    .verify(({ request, rawBody }) => {
      if (!options.credential) {
        return
      }
      verifySignature(options.credential, rawBody, request.headers.get("x-companycam-signature"))
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
