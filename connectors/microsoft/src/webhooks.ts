import { timingSafeEqual } from "node:crypto"
import { defineWebhook, type WebhookDefinition } from "@sixb/core"
import type { MicrosoftClient } from "./client"
import { MicrosoftProtocolError } from "./errors"
import { isRecord } from "./guards"
import { validateWebhookSecret } from "./surfaces/subscriptions/validation"
import type { MicrosoftEventHandler, MicrosoftWebhookEvent } from "./types/webhooks"

function challenge(request: Request): string | null {
  return new URL(request.url).searchParams.get("validationToken")
}

function parseNotifications(raw: Uint8Array, secret: string): MicrosoftWebhookEvent[] {
  const body: unknown = JSON.parse(new TextDecoder().decode(raw))
  if (!isRecord(body) || !Array.isArray(body.value) || body.value.length === 0) {
    throw new MicrosoftProtocolError("Expected a nonempty Graph notification collection.")
  }
  // Validate the entire batch before invoking any callback, including mixed subscriptions.
  return body.value.map((value: unknown) => {
    if (!isRecord(value) || typeof value.clientState !== "string") {
      throw new MicrosoftProtocolError("Missing notification clientState.")
    }
    const actual = Buffer.from(value.clientState)
    const expected = Buffer.from(secret)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new MicrosoftProtocolError("Invalid notification clientState.")
    }
    if (
      typeof value.subscriptionId !== "string" ||
      !value.subscriptionId ||
      typeof value.tenantId !== "string" ||
      !value.tenantId ||
      (value.subscriptionExpirationDateTime !== undefined &&
        typeof value.subscriptionExpirationDateTime !== "string")
    ) {
      throw new MicrosoftProtocolError("Invalid Graph notification identity.")
    }
    const common = {
      subscriptionId: value.subscriptionId,
      tenantId: value.tenantId,
      ...(typeof value.subscriptionExpirationDateTime === "string"
        ? { subscriptionExpirationDateTime: value.subscriptionExpirationDateTime }
        : {}),
    }
    if (value.lifecycleEvent !== undefined) {
      if (
        value.lifecycleEvent !== "reauthorizationRequired" &&
        value.lifecycleEvent !== "subscriptionRemoved" &&
        value.lifecycleEvent !== "missed"
      ) {
        throw new MicrosoftProtocolError("Invalid Graph lifecycle event.")
      }
      return { ...common, kind: "lifecycle", lifecycleEvent: value.lifecycleEvent }
    }
    if (
      (value.changeType !== "created" &&
        value.changeType !== "updated" &&
        value.changeType !== "deleted") ||
      typeof value.resource !== "string" ||
      !value.resource
    ) {
      throw new MicrosoftProtocolError("Invalid Graph change notification.")
    }
    const data = value.resourceData
    if (
      data !== undefined &&
      (!isRecord(data) ||
        ["id", "@odata.type", "@odata.id", "@odata.etag"].some(
          (key) => data[key] !== undefined && typeof data[key] !== "string"
        ))
    ) {
      throw new MicrosoftProtocolError("Invalid Graph notification resourceData.")
    }
    return {
      ...common,
      kind: "change",
      changeType: value.changeType,
      resource: value.resource,
      ...(isRecord(data)
        ? {
            resourceData: {
              ...(typeof data.id === "string" ? { id: data.id } : {}),
              ...(typeof data["@odata.type"] === "string"
                ? { "@odata.type": data["@odata.type"] }
                : {}),
              ...(typeof data["@odata.id"] === "string" ? { "@odata.id": data["@odata.id"] } : {}),
              ...(typeof data["@odata.etag"] === "string"
                ? { "@odata.etag": data["@odata.etag"] }
                : {}),
            },
          }
        : {}),
    }
  })
}

export function microsoftEventsWebhook(
  secret: string,
  onEvent: MicrosoftEventHandler
): WebhookDefinition<Uint8Array, MicrosoftClient> {
  validateWebhookSecret(secret)
  return defineWebhook("events")
    .post()
    .raw()
    .verify(({ request, rawBody }) => {
      // Microsoft validates both URLs with an unauthenticated POST and an opaque query token.
      if (challenge(request) !== null) return
      parseNotifications(rawBody, secret)
    })
    .handle<MicrosoftClient>(async ({ request, rawBody, sixb, logger, client }) => {
      const token = challenge(request)
      if (token !== null)
        return {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: token,
        }
      // Graph has no stable batch delivery ID. Do not dedupe on resource/subscription IDs:
      // that would discard later changes. Callbacks must tolerate replay after partial failure.
      for (const event of parseNotifications(rawBody, secret)) {
        await onEvent({ event, sixb, logger, client })
      }
    })
}
