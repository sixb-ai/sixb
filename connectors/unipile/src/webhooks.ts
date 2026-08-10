import { timingSafeEqual } from "node:crypto"
import type { WebhookDefinition, WebhookVerification, WebhookVerificationSubject } from "@sixb/core"
import { defineWebhook, resolveWebhookVerification, warnUnverifiedWebhook } from "@sixb/core"
import type {
  UnipileAccountStatusWebhookEvent,
  UnipileClient,
  UnipileEventHandler,
  UnipileMessageAttachment,
  UnipileMessageWebhookEvent,
  UnipileMessagingWebhookEventName,
  UnipileNewRelationWebhookEvent,
  UnipileWebhookAttendee,
  UnipileWebhookEvent,
} from "./types"

export const UNIPILE_WEBHOOK_SECRET_HEADER = "X-Sixb-Unipile-Secret"

export const UNIPILE_WEBHOOK: WebhookVerificationSubject = {
  connector: "SixbUnipile",
  verifies: `the ${UNIPILE_WEBHOOK_SECRET_HEADER} shared secret`,
  credentialOption: "`credential` on `unipileEventsWebhook()`",
  allowOption: "`allowUnverified: true`",
}

export const UNIPILE_CONNECTOR_WEBHOOK: WebhookVerificationSubject = {
  ...UNIPILE_WEBHOOK,
  credentialOption: "`webhookSecret` on `unipile()`",
  allowOption: "`webhookAllowUnverified: true`",
}

export type UnipileEventsWebhookOptions = WebhookVerification & {
  readonly onEvent: UnipileEventHandler
}

/** Inbound route for message, account-status, and new-relation deliveries. */
export function unipileEventsWebhook(
  options: UnipileEventsWebhookOptions
): WebhookDefinition<UnipileWebhookEvent, UnipileClient> {
  return createUnipileEventsWebhook(options, UNIPILE_WEBHOOK)
}

/** Package-internal: the connector factory uses option names from `unipile()`. */
export function createUnipileEventsWebhook(
  options: UnipileEventsWebhookOptions,
  subject: WebhookVerificationSubject
): WebhookDefinition<UnipileWebhookEvent, UnipileClient> {
  warnUnverifiedWebhook(subject, resolveWebhookVerification(subject, options))

  return defineWebhook("events")
    .post()
    .json({ parse: parseUnipileWebhookEvent })
    .verify(({ request }) => {
      if (!options.credential) {
        return
      }
      verifySecret(options.credential, request.headers.get(UNIPILE_WEBHOOK_SECRET_HEADER))
    })
    .idempotencyKey(({ body }) => webhookIdempotencyKey(body))
    .handle<UnipileClient>(async ({ body, request, sixb, logger, client }) => {
      await options.onEvent({ event: body, request, sixb, logger, client })
      return { status: 200 }
    })
}

const MESSAGE_EVENTS: readonly UnipileMessagingWebhookEventName[] = [
  "message_received",
  "message_read",
  "message_reaction",
  "message_edited",
  "message_deleted",
  "message_delivered",
]

function parseUnipileWebhookEvent(value: unknown): UnipileWebhookEvent {
  if (!isRecord(value)) {
    throw unexpectedPayload()
  }

  if (isRecord(value.AccountStatus)) {
    return parseAccountStatusEvent(value)
  }

  if (value.event === "new_relation") {
    return parseNewRelationEvent(value)
  }

  if (isMember(value.event, MESSAGE_EVENTS)) {
    return parseMessageEvent(value, value.event)
  }

  throw unexpectedPayload()
}

function parseMessageEvent(
  value: Record<string, unknown>,
  event: UnipileMessagingWebhookEventName
): UnipileMessageWebhookEvent {
  if (
    typeof value.account_id !== "string" ||
    typeof value.account_type !== "string" ||
    typeof value.chat_id !== "string" ||
    typeof value.timestamp !== "string" ||
    typeof value.message_id !== "string"
  ) {
    throw unexpectedPayload()
  }

  const sender = parseAttendee(value.sender, "sender")
  const attendees = value.attendees === undefined ? [] : parseAttendees(value.attendees)
  const attachments = value.attachments === undefined ? [] : parseAttachments(value.attachments)
  const message = value.message === null || typeof value.message === "string" ? value.message : null

  return {
    ...value,
    kind: "message",
    event,
    account_id: value.account_id,
    account_type: value.account_type,
    account_info: isRecord(value.account_info) ? value.account_info : undefined,
    chat_id: value.chat_id,
    timestamp: value.timestamp,
    webhook_name: typeof value.webhook_name === "string" ? value.webhook_name : undefined,
    message_id: value.message_id,
    message,
    sender,
    attendees,
    attachments,
    reaction: typeof value.reaction === "string" ? value.reaction : undefined,
    reaction_sender:
      value.reaction_sender === undefined
        ? undefined
        : parseAttendee(value.reaction_sender, "reaction_sender"),
  }
}

function parseAccountStatusEvent(value: Record<string, unknown>): UnipileAccountStatusWebhookEvent {
  const status = value.AccountStatus
  if (
    !isRecord(status) ||
    typeof status.account_id !== "string" ||
    typeof status.account_type !== "string" ||
    typeof status.message !== "string"
  ) {
    throw unexpectedPayload()
  }

  return {
    ...value,
    kind: "account_status",
    AccountStatus: {
      ...status,
      account_id: status.account_id,
      account_type: status.account_type,
      message: status.message,
      product: typeof status.product === "string" ? status.product : undefined,
    },
  }
}

function parseNewRelationEvent(value: Record<string, unknown>): UnipileNewRelationWebhookEvent {
  if (
    typeof value.account_id !== "string" ||
    value.account_type !== "LINKEDIN" ||
    typeof value.user_full_name !== "string" ||
    typeof value.user_provider_id !== "string" ||
    typeof value.user_public_identifier !== "string" ||
    typeof value.user_profile_url !== "string"
  ) {
    throw unexpectedPayload()
  }

  return {
    ...value,
    kind: "new_relation",
    event: "new_relation",
    account_id: value.account_id,
    account_type: "LINKEDIN",
    webhook_name: typeof value.webhook_name === "string" ? value.webhook_name : undefined,
    user_full_name: value.user_full_name,
    user_provider_id: value.user_provider_id,
    user_public_identifier: value.user_public_identifier,
    user_profile_url: value.user_profile_url,
    user_picture_url:
      typeof value.user_picture_url === "string" ? value.user_picture_url : undefined,
  }
}

function parseAttendees(value: unknown): readonly UnipileWebhookAttendee[] {
  if (!Array.isArray(value)) {
    throw unexpectedPayload()
  }
  return value.map((attendee) => parseAttendee(attendee, "attendee"))
}

function parseAttendee(value: unknown, label: string): UnipileWebhookAttendee {
  if (
    !isRecord(value) ||
    typeof value.attendee_id !== "string" ||
    typeof value.attendee_name !== "string" ||
    typeof value.attendee_provider_id !== "string"
  ) {
    throw new Error(`[SixbUnipile] Unexpected webhook ${label}.`)
  }
  return {
    attendee_id: value.attendee_id,
    attendee_name: value.attendee_name,
    attendee_provider_id: value.attendee_provider_id,
    attendee_profile_url:
      typeof value.attendee_profile_url === "string" ? value.attendee_profile_url : undefined,
  }
}

function parseAttachments(value: unknown): readonly UnipileMessageAttachment[] {
  if (!Array.isArray(value)) {
    throw unexpectedPayload()
  }
  return value.map((attachment) => {
    if (
      !isRecord(attachment) ||
      typeof attachment.id !== "string" ||
      typeof attachment.type !== "string" ||
      typeof attachment.unavailable !== "boolean"
    ) {
      throw new Error("[SixbUnipile] Unexpected webhook attachment.")
    }
    return {
      ...attachment,
      id: attachment.id,
      type: attachment.type,
      unavailable: attachment.unavailable,
    }
  })
}

function webhookIdempotencyKey(event: UnipileWebhookEvent): string | undefined {
  if (event.kind === "message") {
    return [
      event.event,
      event.account_id,
      event.message_id,
      event.timestamp,
      event.reaction ?? "",
      event.reaction_sender?.attendee_provider_id ?? "",
    ].join(":")
  }
  if (event.kind === "new_relation") {
    return `${event.event}:${event.account_id}:${event.user_provider_id}`
  }

  // Account-status deliveries have no event or delivery id. De-duplicating on status would also
  // suppress a legitimate later transition back to the same status.
  return undefined
}

function verifySecret(expected: string, received: string | null): void {
  if (!received) {
    throw new Error(`[SixbUnipile] Missing ${UNIPILE_WEBHOOK_SECRET_HEADER} header.`)
  }

  const expectedBytes = Buffer.from(expected)
  const receivedBytes = Buffer.from(received)
  if (
    expectedBytes.length !== receivedBytes.length ||
    !timingSafeEqual(expectedBytes, receivedBytes)
  ) {
    throw new Error("[SixbUnipile] Invalid webhook shared secret.")
  }
}

function unexpectedPayload(): Error {
  return new Error("[SixbUnipile] Unexpected webhook payload.")
}

function isMember<T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === "string" && members.includes(value as T)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
