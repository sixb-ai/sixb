import {
  defineWebhook,
  type WebhookConnection,
  type WebhookDefinition,
  type WebhookHandlerContext,
} from "@sixb/core"
import type { MicrosoftClient } from "./client"
import { personalClientStateAccount, sharedClientStateMatches } from "./client-state"
import { MicrosoftProtocolError } from "./errors"
import { isRecord } from "./guards"
import { validateWebhookSecret } from "./surfaces/subscriptions/validation"
import type {
  MicrosoftEventHandler,
  MicrosoftOAuthEventHandler,
  MicrosoftWebhookEvent,
} from "./types/webhooks"

interface Notification {
  readonly clientState: string
  readonly event: MicrosoftWebhookEvent
}

function parseNotifications(raw: Uint8Array): Notification[] {
  const body: unknown = JSON.parse(new TextDecoder().decode(raw))
  if (!isRecord(body) || !Array.isArray(body.value) || body.value.length === 0) {
    throw new MicrosoftProtocolError("Expected a nonempty Graph notification collection.")
  }
  return body.value.map((value: unknown) => {
    if (!isRecord(value) || typeof value.clientState !== "string") {
      throw new MicrosoftProtocolError("Missing notification clientState.")
    }
    return { clientState: value.clientState, event: parseEvent(value) }
  })
}

function parseEvent(value: Record<string, unknown>): MicrosoftWebhookEvent {
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
}

/** Graph's validation handshake: an unauthenticated POST whose query carries an opaque token. */
function challenge(request: Request): string | null {
  return new URL(request.url).searchParams.get("validationToken")
}

/**
 * Every item's clientState is checked before any callback runs, so one forged item rejects the
 * whole batch, including batches that mix subscriptions.
 */
function eventsWebhook<TSender>(
  authenticate: (clientState: string) => TSender,
  dispatch: (
    batch: readonly { readonly event: MicrosoftWebhookEvent; readonly sender: TSender }[],
    context: WebhookHandlerContext<Uint8Array, MicrosoftClient>
  ) => Promise<void>
): WebhookDefinition<Uint8Array, MicrosoftClient> {
  const admit = (rawBody: Uint8Array) =>
    parseNotifications(rawBody).map(({ clientState, event }) => ({
      event,
      sender: authenticate(clientState),
    }))
  return defineWebhook("events")
    .post()
    .raw()
    .verify(({ request, rawBody }) => {
      if (challenge(request) !== null) return
      admit(rawBody)
    })
    .handle<MicrosoftClient>(async (context) => {
      const token = challenge(context.request)
      if (token !== null)
        return {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: token,
        }
      // Graph has no stable batch delivery ID. Do not dedupe on resource/subscription IDs:
      // that would discard later changes. Callbacks must tolerate replay after partial failure.
      await dispatch(admit(context.rawBody), context)
    })
}

/** Application connections: every subscription carries the webhook secret itself. */
export function microsoftEventsWebhook(
  secret: string,
  onEvent: MicrosoftEventHandler
): WebhookDefinition<Uint8Array, MicrosoftClient> {
  validateWebhookSecret(secret)
  return eventsWebhook(
    (clientState) => {
      if (!sharedClientStateMatches(secret, clientState))
        throw new MicrosoftProtocolError("Invalid notification clientState.")
    },
    async (batch, { sixb, logger, client }) => {
      for (const { event } of batch) await onEvent({ event, sixb, logger, client })
    }
  )
}

/**
 * People's own connections: each subscription's clientState names the account that made it, and
 * the callback gets that account's connections, the only ones whose token Graph accepts for the
 * subscription.
 */
export function microsoftOAuthEventsWebhook(
  secret: string,
  onEvent: MicrosoftOAuthEventHandler
): WebhookDefinition<Uint8Array, MicrosoftClient> {
  validateWebhookSecret(secret)
  return eventsWebhook(
    (clientState) => {
      const accountId = personalClientStateAccount(secret, clientState)
      if (accountId === undefined)
        throw new MicrosoftProtocolError("Invalid notification clientState.")
      return accountId
    },
    async (batch, { sixb, logger, connections }) => {
      // One lookup per account per batch; a batch can hold many notifications for one mailbox.
      const resolved = new Map<string, readonly WebhookConnection<MicrosoftClient>[]>()
      for (const { event, sender: accountId } of batch) {
        let targets = resolved.get(accountId)
        if (targets === undefined) {
          targets = await connections.forAccount(accountId)
          resolved.set(accountId, targets)
        }
        await onEvent({ event, accountId, connections: targets, sixb, logger })
      }
    }
  )
}
