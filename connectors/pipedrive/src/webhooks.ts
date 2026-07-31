import { timingSafeEqual } from "node:crypto"
import type { WebhookDefinition, WebhookVerification, WebhookVerificationSubject } from "@sixb/core"
import { defineWebhook, resolveWebhookVerification, warnUnverifiedWebhook } from "@sixb/core"
import type {
  PipedriveClient,
  PipedriveEventHandler,
  PipedriveJsonObject,
  PipedriveJsonValue,
  PipedriveWebhookBasicAuth,
  PipedriveWebhookEvent,
  PipedriveWebhookMeta,
} from "./types"

export const PIPEDRIVE_WEBHOOK: WebhookVerificationSubject = {
  connector: "SixbPipedrive",
  verifies: "the Authorization basic-auth credentials",
  secretOption: "`secret` on pipedriveEventsWebhook",
}

/** Either basic-auth credentials or an explicit decision to do without them. */
type PipedriveEventsWebhookOptions = WebhookVerification<PipedriveWebhookBasicAuth> & {
  readonly onEvent: PipedriveEventHandler
}

export function pipedriveEventsWebhook(
  options: PipedriveEventsWebhookOptions
): WebhookDefinition<PipedriveWebhookEvent, PipedriveClient> {
  warnUnverifiedWebhook(PIPEDRIVE_WEBHOOK, resolveWebhookVerification(PIPEDRIVE_WEBHOOK, options))

  return defineWebhook("events")
    .post()
    .json({ parse: parsePipedriveWebhookEvent })
    .verify(({ request }) => {
      if (!options.secret) {
        return
      }
      verifyBasicAuth(options.secret, request.headers.get("authorization"))
    })
    .idempotencyKey(({ body }) => body.meta.id ?? body.meta.correlation_id)
    .handle<PipedriveClient>(async ({ body, sixb, logger, client }) => {
      await options.onEvent({ event: body, sixb, logger, client })
      return { status: 200 }
    })
}

function parsePipedriveWebhookEvent(value: unknown): PipedriveWebhookEvent {
  if (!isRecord(value) || !isRecord(value.meta)) {
    throw new Error("[SixbPipedrive] Unexpected webhook payload.")
  }

  if (typeof value.meta.action !== "string" || typeof value.meta.entity !== "string") {
    throw new Error("[SixbPipedrive] Unexpected webhook payload.")
  }

  if (!isJsonObject(value.meta)) {
    throw new Error("[SixbPipedrive] Unexpected webhook meta payload.")
  }

  return {
    meta: value.meta as PipedriveWebhookMeta,
    data: value.data === undefined ? undefined : parseJsonValue(value.data, "data"),
    previous: value.previous === undefined ? undefined : parseJsonValue(value.previous, "previous"),
  }
}

function verifyBasicAuth(auth: PipedriveWebhookBasicAuth, header: string | null): void {
  if (!header?.startsWith("Basic ")) {
    throw new Error("[SixbPipedrive] Missing webhook basic auth.")
  }

  const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`
  const received = Buffer.from(header)
  const computed = Buffer.from(expected)

  if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
    throw new Error("[SixbPipedrive] Invalid webhook basic auth.")
  }
}

function parseJsonValue(value: unknown, field: string): PipedriveJsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`[SixbPipedrive] Unexpected webhook ${field} payload.`)
  }

  return value
}

function isJsonValue(value: unknown): value is PipedriveJsonValue {
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

function isJsonObject(value: unknown): value is PipedriveJsonObject {
  if (!isRecord(value)) {
    return false
  }

  return Object.values(value).every((item) => item === undefined || isJsonValue(item))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
