import type { WebhookDefinition } from "@sixb/core"
import type Stripe from "stripe"
import type { StripeClient } from "./client"
import type { StripeEventHandler } from "./webhooks"

export type StripeApiKeyResolver = string | (() => string | Promise<string>)

/** Per-request options supported by the official Stripe SDK. */
export type StripeRequestOptions = Stripe.RequestOptions

/** Stripe object enriched with response metadata such as `requestId` and `statusCode`. */
export type StripeResponse<T> = Stripe.Response<T>

/** One cursor-paginated Stripe list response. */
export type StripePage<T> = Stripe.ApiList<T>

/** A Stripe list request, which is both awaitable and auto-paginatable. */
export type StripeListPromise<T> = Stripe.ApiListPromise<T>

/** One page returned by Stripe's Search API. */
export type StripeSearchPage<T> = Stripe.ApiSearchResult<T>

/** A Stripe search request, which is both awaitable and auto-paginatable. */
export type StripeSearchPromise<T> = Stripe.ApiSearchResultPromise<T>

export interface StripeConnectorOptions {
  /** Secret API key, or an async resolver evaluated whenever Sixb connects the adapter. */
  readonly apiKey: StripeApiKeyResolver
  /** Automatic retries after the initial request. Defaults to 1 in the Stripe SDK. */
  readonly maxNetworkRetries?: number
  /** Per-request timeout in milliseconds. Defaults to 80 seconds in the Stripe SDK. */
  readonly timeoutMs?: number
  /** Disable to stop sending request latency telemetry to Stripe. Defaults to true upstream. */
  readonly telemetry?: boolean
  /** Account context used for every request, including requests made for Stripe Connect. */
  readonly stripeContext?: string
  /**
   * Handler for inbound snapshot-event webhook deliveries. Providing it registers the connector's
   * `events` route; omit it and the connector exposes no built-in inbound HTTP surface.
   */
  readonly onEvent?: StripeEventHandler
  /** Signing secret beginning with `whsec_`, used to verify the raw webhook request body. */
  readonly webhookSecret?: string
  /** Explicitly register an inbound webhook without signature verification. */
  readonly webhookAllowUnverified?: boolean
  /** Maximum accepted webhook signature age. Defaults to 5 minutes. */
  readonly webhookToleranceMs?: number
  /** Extra inbound webhooks to register alongside the built-in `events` route. */
  readonly webhooks?: readonly WebhookDefinition<unknown, StripeClient>[]
}
