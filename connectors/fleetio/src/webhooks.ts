import { createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookDefinition, WebhookVerification, WebhookVerificationSubject } from "@sixb/core"
import { defineWebhook, resolveWebhookVerification, warnUnverifiedWebhook } from "@sixb/core"
import type { FleetioClient, FleetioEvent, FleetioEventHandler } from "./types"

export const FLEETIO_WEBHOOK: WebhookVerificationSubject = {
  connector: "SixbFleetio",
  verifies: "the X-Fleetio-Webhook-Signature HMAC",
  credentialOption: "`credential` on `fleetioEventsWebhook()`",
  allowOption: "`allowUnverified: true`",
}

/** In the words `fleetio()` uses for the same two options. */
export const FLEETIO_CONNECTOR_WEBHOOK: WebhookVerificationSubject = {
  ...FLEETIO_WEBHOOK,
  credentialOption: "`webhookSecret` on `fleetio()`",
  allowOption: "`webhookAllowUnverified: true`",
}

/** Either a signing secret or an explicit decision to do without one. */
export type FleetioEventsWebhookOptions = WebhookVerification & {
  readonly onEvent: FleetioEventHandler
}

/**
 * Inbound webhook for Fleetio events.
 *
 * Fleetio delivers every subscribed event to one URL, so this registers a single route. It verifies
 * the `X-Fleetio-Webhook-Signature` hex HMAC-SHA256 over the raw body and answers `200`.
 *
 * It deliberately sets no idempotency key. Sixb answers a repeated key with 202, and Fleetio
 * requires a 200 and disables a webhook after three failed messages. A retried delivery therefore
 * runs the handler again, so handlers must be safe to repeat; `event.id` identifies the delivery.
 */
export function fleetioEventsWebhook(
  options: FleetioEventsWebhookOptions
): WebhookDefinition<FleetioEvent, FleetioClient> {
  return createFleetioEventsWebhook(options, FLEETIO_WEBHOOK)
}

/** Package-internal: the connector factory passes the subject written in its own vocabulary. */
export function createFleetioEventsWebhook(
  options: FleetioEventsWebhookOptions,
  subject: WebhookVerificationSubject
): WebhookDefinition<FleetioEvent, FleetioClient> {
  warnUnverifiedWebhook(subject, resolveWebhookVerification(subject, options))

  return defineWebhook("events")
    .post()
    .json({ parse: parseFleetioEvent })
    .verify(({ request, rawBody }) => {
      if (!options.credential) {
        return
      }

      verifySignature(
        options.credential,
        rawBody,
        request.headers.get("x-fleetio-webhook-signature")
      )
    })
    .handle<FleetioClient>(async ({ body, request, sixb, logger, client }) => {
      await options.onEvent({ event: body, request, sixb, logger, client })
      return { status: 200 }
    })
}

/** Unknown event names pass through: Fleetio adds new ones without a version change. */
function parseFleetioEvent(value: unknown): FleetioEvent {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.event !== "string") {
    throw new Error("[SixbFleetio] Unexpected webhook payload.")
  }

  return {
    id: value.id,
    type: value.event,
    timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
    triggeredBy: typeof value.triggered_by === "string" ? value.triggered_by : null,
    payload: isRecord(value.payload) ? value.payload : {},
  }
}

function verifySignature(secret: string, rawBody: Uint8Array, signature: string | null): void {
  if (!signature) {
    throw new Error("[SixbFleetio] Missing X-Fleetio-Webhook-Signature header.")
  }

  const received = Buffer.from(signature)
  const computed = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"))

  if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
    throw new Error("[SixbFleetio] Invalid webhook signature.")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
