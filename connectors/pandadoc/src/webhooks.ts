import { createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookDefinition, WebhookVerification, WebhookVerificationSubject } from "@sixb/core"
import { defineWebhook, resolveWebhookVerification, warnUnverifiedWebhook } from "@sixb/core"
import type {
  PandaDocClient,
  PandaDocJsonObject,
  PandaDocJsonValue,
  PandaDocWebhookEvent,
  PandaDocWebhookEventHandler,
  PandaDocWebhookSharedKeyResolver,
} from "./types"

export const PANDADOC_WEBHOOK: WebhookVerificationSubject = {
  connector: "SixbPandaDoc",
  verifies: "the `signature` query parameter",
  secretOption: "`secret` on pandaDocEventsWebhook",
}

/** Either a shared key or an explicit decision to do without one. */
type PandaDocEventsWebhookOptions = WebhookVerification<PandaDocWebhookSharedKeyResolver> & {
  readonly onEvent: PandaDocWebhookEventHandler
}

export function pandaDocEventsWebhook(
  options: PandaDocEventsWebhookOptions
): WebhookDefinition<readonly PandaDocWebhookEvent[], PandaDocClient> {
  warnUnverifiedWebhook(PANDADOC_WEBHOOK, resolveWebhookVerification(PANDADOC_WEBHOOK, options))

  return defineWebhook("events")
    .post()
    .json({ parse: parsePandaDocWebhookEvents })
    .verify(async ({ request, rawBody }) => {
      if (!options.secret) {
        return
      }

      verifySignature(
        await resolveSharedKey(options.secret),
        rawBody,
        new URL(request.url).searchParams.get("signature")
      )
    })
    .handle<PandaDocClient>(async ({ body, request, sixb, logger, client }) => {
      for (const event of body) {
        await options.onEvent({ event, events: body, request, sixb, logger, client })
      }

      return { status: 200 }
    })
}

function parsePandaDocWebhookEvents(value: unknown): readonly PandaDocWebhookEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("[SixbPandaDoc] Unexpected webhook payload.")
  }

  return value.map(parsePandaDocWebhookEvent)
}

function parsePandaDocWebhookEvent(value: unknown): PandaDocWebhookEvent {
  if (!isRecord(value) || typeof value.event !== "string" || !isRecord(value.data)) {
    throw new Error("[SixbPandaDoc] Unexpected webhook event payload.")
  }

  if (!isJsonObject(value.data)) {
    throw new Error("[SixbPandaDoc] Unexpected webhook event data payload.")
  }

  return {
    ...value,
    event: value.event,
    data: value.data,
  } as PandaDocWebhookEvent
}

function verifySignature(secret: string, rawBody: Uint8Array, signature: string | null): void {
  if (!signature) {
    throw new Error("[SixbPandaDoc] Missing webhook signature.")
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex")
  const received = Buffer.from(signature.trim().toLowerCase())
  const computed = Buffer.from(expected)

  if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
    throw new Error("[SixbPandaDoc] Invalid webhook signature.")
  }
}

async function resolveSharedKey(key: PandaDocWebhookSharedKeyResolver): Promise<string> {
  const value = typeof key === "function" ? await key() : key
  if (!value.trim()) {
    throw new Error("[SixbPandaDoc] webhookSharedKey must not be empty.")
  }

  return value
}

function isJsonValue(value: unknown): value is PandaDocJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }

  return isJsonObject(value)
}

function isJsonObject(value: unknown): value is PandaDocJsonObject {
  if (!isRecord(value)) {
    return false
  }

  return Object.values(value).every((item) => item === undefined || isJsonValue(item))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
