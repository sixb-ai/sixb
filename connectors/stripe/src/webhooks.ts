import type { Logger, OntologySource, Sixb } from "@sixb/core"
import {
  defineWebhook,
  resolveWebhookVerification,
  type WebhookDefinition,
  type WebhookVerification,
  type WebhookVerificationSubject,
  warnUnverifiedWebhook,
} from "@sixb/core"
import Stripe from "stripe"
import type { StripeClient } from "./client"
import type { StripeEvent } from "./resources/events"

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000

export const STRIPE_WEBHOOK: WebhookVerificationSubject = {
  connector: "SixbStripe",
  verifies: "the Stripe-Signature HMAC",
  credentialOption: "`credential` on `stripeEventsWebhook()`",
  allowOption: "`allowUnverified: true`",
}

export const STRIPE_CONNECTOR_WEBHOOK: WebhookVerificationSubject = {
  ...STRIPE_WEBHOOK,
  credentialOption: "`webhookSecret` on `stripe()`",
  allowOption: "`webhookAllowUnverified: true`",
}

export interface StripeEventContext {
  readonly event: StripeEvent
  readonly request: Request
  readonly sixb: Sixb<readonly OntologySource[]>
  readonly logger: Logger
  /** Resolves the Stripe client lazily, only if the handler needs to read current state. */
  client(): Promise<StripeClient>
}

export type StripeEventHandler = (context: StripeEventContext) => Promise<void> | void

export type StripeEventsWebhookOptions = WebhookVerification & {
  readonly onEvent: StripeEventHandler
  /** Maximum accepted signature age. Defaults to 5 minutes. */
  readonly toleranceMs?: number
}

/**
 * Verified inbound webhook for Stripe v1 snapshot events.
 *
 * The raw bytes are checked with the official Stripe SDK before JSON parsing. The event id is
 * reported as the delivery idempotency key because Stripe retries webhook deliveries.
 */
export function stripeEventsWebhook(
  options: StripeEventsWebhookOptions
): WebhookDefinition<StripeEvent, StripeClient> {
  return createStripeEventsWebhook(options, STRIPE_WEBHOOK)
}

export function createStripeEventsWebhook(
  options: StripeEventsWebhookOptions,
  subject: WebhookVerificationSubject
): WebhookDefinition<StripeEvent, StripeClient> {
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS
  assertToleranceMs(toleranceMs)

  const verification = resolveWebhookVerification(subject, options)
  warnUnverifiedWebhook(subject, verification)

  return defineWebhook("events")
    .post()
    .json({ parse: parseStripeEvent })
    .verify(async ({ request, rawBody }) => {
      if (!verification.credential) return

      const signature = request.headers.get("stripe-signature")
      if (!signature) {
        throw new Error("[SixbStripe] Missing Stripe-Signature header.")
      }

      await Stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        verification.credential,
        toleranceMs / 1000
      )
    })
    .idempotencyKey(({ body }) => body.id)
    .handle<StripeClient>(async ({ body, request, sixb, logger, client }) => {
      await options.onEvent({ event: body, request, sixb, logger, client })
      return { status: 200 }
    })
}

function parseStripeEvent(value: unknown): StripeEvent {
  if (!isRecord(value) || value.object !== "event" || typeof value.id !== "string") {
    throw new Error("[SixbStripe] Unexpected webhook payload.")
  }
  if (typeof value.type !== "string" || !isRecord(value.data)) {
    throw new Error("[SixbStripe] Webhook event is missing type or data.")
  }

  return Stripe.webhooks.constructEventWithoutVerification(JSON.stringify(value))
}

function assertToleranceMs(toleranceMs: number): void {
  if (!Number.isFinite(toleranceMs) || toleranceMs <= 0) {
    throw new Error("[SixbStripe] webhookToleranceMs must be a positive finite number.")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
