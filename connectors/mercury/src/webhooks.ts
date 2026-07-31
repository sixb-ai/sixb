import { createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookDefinition, WebhookVerification, WebhookVerificationSubject } from "@sixb/core"
import { defineWebhook, resolveWebhookVerification, warnUnsignedWebhook } from "@sixb/core"
import type {
  MercuryClient,
  MercuryEvent,
  MercuryEventHandler,
  MercuryEventOperationType,
  MercuryEventResourceType,
} from "./types"

/** Mercury's recommended replay window for webhook signature timestamps. */
const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000

export const MERCURY_WEBHOOK: WebhookVerificationSubject = {
  connector: "Mercury",
  header: "Mercury-Signature",
  secretOption: "`secret` on mercuryEventsWebhook",
}

/**
 * Either a signing secret or an explicit decision to do without one. For a banking
 * connector especially, an unverified route is a decision and not a default — so the type
 * has no shape that expresses neither.
 */
export type MercuryEventsWebhookOptions = WebhookVerification & {
  readonly onEvent: MercuryEventHandler
  /** Maximum accepted signature age. Defaults to 5 minutes. */
  readonly toleranceMs?: number
}

/**
 * Inbound webhook for Mercury events.
 *
 * Mercury delivers every subscribed event type to one URL, so this registers a single route. It
 * verifies the `Mercury-Signature` HMAC-SHA256 over `<timestamp>.<raw body>`, rejects timestamps
 * outside the replay window, and reports the event id as the idempotency key — deliveries are
 * at-least-once, so the runtime uses that to drop duplicates.
 */
export function mercuryEventsWebhook(
  options: MercuryEventsWebhookOptions
): WebhookDefinition<MercuryEvent, MercuryClient> {
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS
  assertToleranceMs(toleranceMs)

  // Resolved, not just warned about: the union makes this unreachable from TypeScript,
  // and a caller without types still gets the refusal rather than an open route.
  warnUnsignedWebhook(MERCURY_WEBHOOK, resolveWebhookVerification(MERCURY_WEBHOOK, options))

  return defineWebhook("events")
    .post()
    .json({ parse: parseMercuryEvent })
    .verify(({ request, rawBody }) => {
      if (!options.secret) {
        return
      }

      verifySignature(
        options.secret,
        rawBody,
        request.headers.get("mercury-signature"),
        toleranceMs
      )
    })
    .idempotencyKey(({ body }) => body.id)
    .handle<MercuryClient>(async ({ body, request, sixb, logger, client }) => {
      await options.onEvent({ event: body, request, sixb, logger, client })
      return { status: 200 }
    })
}

const RESOURCE_TYPES: readonly MercuryEventResourceType[] = [
  "transaction",
  "checkingAccount",
  "savingsAccount",
  "treasuryAccount",
  "investmentAccount",
  "creditAccount",
]

const OPERATION_TYPES: readonly MercuryEventOperationType[] = ["create", "update", "delete"]

function parseMercuryEvent(value: unknown): MercuryEvent {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("[SixbMercury] Unexpected webhook payload.")
  }

  if (!isMember(value.resourceType, RESOURCE_TYPES)) {
    throw new Error(`[SixbMercury] Unknown webhook resourceType: ${String(value.resourceType)}.`)
  }

  if (!isMember(value.operationType, OPERATION_TYPES)) {
    throw new Error(`[SixbMercury] Unknown webhook operationType: ${String(value.operationType)}.`)
  }

  if (typeof value.resourceId !== "string" || typeof value.occurredAt !== "string") {
    throw new Error("[SixbMercury] Webhook payload is missing resourceId or occurredAt.")
  }

  return {
    id: value.id,
    resourceType: value.resourceType,
    resourceId: value.resourceId,
    operationType: value.operationType,
    resourceVersion: typeof value.resourceVersion === "number" ? value.resourceVersion : 1,
    occurredAt: value.occurredAt,
    changedPaths: Array.isArray(value.changedPaths)
      ? value.changedPaths.filter((path): path is string => typeof path === "string")
      : [],
    mergePatch: isRecord(value.mergePatch) ? value.mergePatch : {},
    previousValues: isRecord(value.previousValues) ? value.previousValues : null,
  }
}

/**
 * Verifies `Mercury-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>`. The signed message is
 * `<timestamp>.<raw body>`, so the raw bytes must be used as received — reserializing the JSON
 * would change the digest.
 */
function verifySignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | null,
  toleranceMs: number
): void {
  if (!signatureHeader) {
    throw new Error("[SixbMercury] Missing Mercury-Signature header.")
  }

  const { timestamp, signature } = parseSignatureHeader(signatureHeader)
  assertFreshTimestamp(timestamp, toleranceMs)

  const hmac = createHmac("sha256", secret)
  hmac.update(`${timestamp}.`)
  hmac.update(rawBody)

  const received = Buffer.from(signature)
  const computed = Buffer.from(hmac.digest("hex"))

  if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
    throw new Error("[SixbMercury] Invalid webhook signature.")
  }
}

function parseSignatureHeader(header: string): { timestamp: string; signature: string } {
  let timestamp: string | undefined
  let signature: string | undefined

  for (const part of header.split(",")) {
    const separator = part.indexOf("=")
    if (separator === -1) {
      continue
    }

    const key = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    if (key === "t") {
      timestamp = value
    } else if (key === "v1") {
      signature = value
    }
  }

  if (!timestamp || !signature) {
    throw new Error("[SixbMercury] Malformed Mercury-Signature header.")
  }

  return { timestamp, signature }
}

function assertFreshTimestamp(timestamp: string, toleranceMs: number): void {
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds)) {
    throw new Error("[SixbMercury] Malformed Mercury-Signature timestamp.")
  }

  if (Math.abs(Date.now() - seconds * 1000) > toleranceMs) {
    throw new Error("[SixbMercury] Webhook signature timestamp is outside the allowed window.")
  }
}

function assertToleranceMs(toleranceMs: number): void {
  if (!Number.isFinite(toleranceMs) || toleranceMs <= 0) {
    throw new Error("[SixbMercury] webhookToleranceMs must be a positive finite number.")
  }
}

function isMember<T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === "string" && members.includes(value as T)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
