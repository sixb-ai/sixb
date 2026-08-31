import type { ConnectorAdapter, WebhookDefinition } from "@sixb/core"
import { resolveWebhookVerification } from "@sixb/core"
import Stripe from "stripe"
import { createStripeClient, type StripeClient } from "./client"
import type { StripeApiKeyResolver, StripeConnectorOptions } from "./types"
import {
  createStripeEventsWebhook,
  STRIPE_CONNECTOR_WEBHOOK,
  type StripeEventsWebhookOptions,
} from "./webhooks"

export type StripeConnector = ConnectorAdapter<"stripe", StripeClient>

/**
 * Stripe Billing connector backed by Stripe's official Node SDK.
 *
 * The connected client exposes only the five supported resource groups: customers,
 * subscriptions, invoices, refunds, and snapshot events.
 */
export function stripe(options: StripeConnectorOptions): StripeConnector {
  assertApiKeyResolver(options.apiKey)
  assertOptions(options)

  return {
    type: "stripe",
    webhooks: collectWebhooks(options),
    async connect(context) {
      context.signal.throwIfAborted()
      const apiKey = await resolveApiKey(options.apiKey)
      context.signal.throwIfAborted()

      const sdk = new Stripe(apiKey, {
        appInfo: {
          name: "@sixb/connector-stripe",
          url: "https://github.com/sixb-ai/sixb/tree/main/connectors/stripe",
        },
        typescript: true,
        maxNetworkRetries: options.maxNetworkRetries,
        timeout: options.timeoutMs,
        telemetry: options.telemetry,
        stripeContext: options.stripeContext,
      })

      return createStripeClient(sdk)
    },
  }
}

function collectWebhooks(
  options: StripeConnectorOptions
): readonly WebhookDefinition<unknown, StripeClient>[] | undefined {
  const webhooks: WebhookDefinition<unknown, StripeClient>[] = []

  if (options.onEvent) {
    webhooks.push(
      createStripeEventsWebhook(
        {
          onEvent: options.onEvent,
          ...resolveWebhookVerification(STRIPE_CONNECTOR_WEBHOOK, {
            credential: options.webhookSecret,
            allowUnverified: options.webhookAllowUnverified,
          }),
          toleranceMs: options.webhookToleranceMs,
        } satisfies StripeEventsWebhookOptions,
        STRIPE_CONNECTOR_WEBHOOK
      ) as WebhookDefinition<unknown, StripeClient>
    )
  }

  if (options.webhooks) webhooks.push(...options.webhooks)
  return webhooks.length > 0 ? webhooks : undefined
}

function assertApiKeyResolver(apiKey: StripeApiKeyResolver): void {
  if (typeof apiKey === "string" && !apiKey.trim()) {
    throw new Error("[SixbStripe] apiKey must not be empty.")
  }
  if (typeof apiKey !== "string" && typeof apiKey !== "function") {
    throw new Error("[SixbStripe] apiKey must be a string or a function.")
  }
}

async function resolveApiKey(apiKey: StripeApiKeyResolver): Promise<string> {
  const value = typeof apiKey === "function" ? await apiKey() : apiKey
  if (!value.trim()) {
    throw new Error("[SixbStripe] apiKey must not be empty.")
  }
  return value
}

function assertOptions(options: StripeConnectorOptions): void {
  if (
    options.maxNetworkRetries !== undefined &&
    (!Number.isInteger(options.maxNetworkRetries) || options.maxNetworkRetries < 0)
  ) {
    throw new Error("[SixbStripe] maxNetworkRetries must be a non-negative integer.")
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error("[SixbStripe] timeoutMs must be a positive finite number.")
  }
  if (options.stripeContext !== undefined && !options.stripeContext.trim()) {
    throw new Error("[SixbStripe] stripeContext must not be empty.")
  }
  if (options.webhookSecret !== undefined && !options.webhookSecret.trim()) {
    throw new Error("[SixbStripe] webhookSecret must not be empty.")
  }
}
