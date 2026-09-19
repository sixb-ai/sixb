import { createHmac, timingSafeEqual } from "node:crypto"
import {
  defineWebhook,
  type WebhookDefinition,
  type WebhookHandlerContext,
  type WebhookHandlerResult,
  type WebhookIdempotencyKeyResolver,
} from "@sixb/core"
import type { QuickBooksClient } from "./types"
import { isRecord, nonEmpty, realmId } from "./validation"

export interface QuickBooksCloudEvent {
  readonly specversion: "1.0"
  readonly id: string
  readonly source: string
  readonly type: string
  readonly time: string
  readonly intuitaccountid: string
  readonly intuitentityid: string
  readonly datacontenttype?: string
  readonly data?: unknown
  readonly [extension: string]: unknown
}

export type QuickBooksEventContext = WebhookHandlerContext<
  readonly QuickBooksCloudEvent[],
  QuickBooksClient
>

export interface QuickBooksEventsWebhookOptions {
  readonly verifierToken: string
  /** Receives the whole CloudEvents array in context.body; return an optional HTTP response. */
  readonly onEvent: (
    context: QuickBooksEventContext
  ) => WebhookHandlerResult | Promise<WebhookHandlerResult>
  /** Optional application-owned request identity. Individual event IDs are not delivery IDs. */
  readonly idempotencyKey?: WebhookIdempotencyKeyResolver<readonly QuickBooksCloudEvent[]>
}

export function quickbooksEventsWebhook(
  options: QuickBooksEventsWebhookOptions
): WebhookDefinition<readonly QuickBooksCloudEvent[], QuickBooksClient> {
  nonEmpty(options.verifierToken, "webhook verifierToken")
  if (typeof options.onEvent !== "function")
    throw new Error("[SixbQuickBooks] webhook onEvent must be a function.")
  const { verifierToken, onEvent } = options
  let builder = defineWebhook("events")
    .post()
    .json({ parse: parseCloudEvents })
    .verify(({ request, rawBody }) => {
      const signature = request.headers.get("intuit-signature")
      if (!signature || !/^[A-Za-z0-9+/]{43}=$/.test(signature))
        throw new Error("[SixbQuickBooks] Missing or malformed intuit-signature.")
      const received = Buffer.from(signature, "base64")
      const expected = createHmac("sha256", verifierToken).update(rawBody).digest()
      if (
        received.toString("base64") !== signature ||
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      )
        throw new Error("[SixbQuickBooks] Invalid webhook signature.")
    })
  if (options.idempotencyKey) builder = builder.idempotencyKey(options.idempotencyKey)
  return builder.handle<QuickBooksClient>(
    async (context) => (await onEvent(context)) ?? { status: 200 }
  )
}

function parseCloudEvents(value: unknown): readonly QuickBooksCloudEvent[] {
  if (!Array.isArray(value))
    throw new Error(
      "[SixbQuickBooks] Expected a CloudEvents array; enable CloudEvents format in Intuit."
    )
  for (const event of value) {
    if (!isRecord(event) || event.specversion !== "1.0")
      throw new Error("[SixbQuickBooks] Invalid CloudEvent version.")
    for (const field of ["id", "source", "type", "time", "intuitentityid"] as const)
      nonEmpty(event[field], `CloudEvent ${field}`)
    realmId(event.intuitaccountid)
    if (
      !Number.isFinite(Date.parse(event.time as string)) ||
      (event.datacontenttype !== undefined && typeof event.datacontenttype !== "string")
    )
      throw new Error("[SixbQuickBooks] Invalid CloudEvent metadata.")
  }
  return value as QuickBooksCloudEvent[]
}
