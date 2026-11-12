import { timingSafeEqual } from "node:crypto"
import type { WebhookDefinition, WebhookVerification, WebhookVerificationSubject } from "@sixb/core"
import {
  defineWebhook,
  resolveWebhookVerification,
  UnverifiedWebhookError,
  warnUnverifiedWebhook,
} from "@sixb/core"
import type { CtmCall, CtmClient, CtmEvent, CtmEventHandler, CtmWebhookBasicAuth } from "./types"
import { isRecord } from "./validation"

export const CTM_WEBHOOK: WebhookVerificationSubject = {
  connector: "SixbCtm",
  verifies: "the Authorization basic-auth header",
  credentialOption: "`credential` on `ctmEventsWebhook()`",
  allowOption: "`allowUnverified: true`",
}

/** In the words `ctm()` uses for the same two options. */
export const CTM_CONNECTOR_WEBHOOK: WebhookVerificationSubject = {
  ...CTM_WEBHOOK,
  credentialOption: "`webhookAuth` on `ctm()`",
  allowOption: "`webhookAllowUnverified: true`",
}

/** Either the webhook's basic-auth credential or an explicit decision to do without it. */
export type CtmEventsWebhookOptions = WebhookVerification<CtmWebhookBasicAuth> & {
  readonly onEvent: CtmEventHandler
}

/**
 * Inbound route for CTM webhooks registered with `hooktype: "call"`.
 *
 * CTM signs nothing; the only proof a delivery came from CTM is the username and password set on
 * the webhook, which it sends as basic auth. CTM's body is the activity alone and does not say
 * which trigger fired, so a project with several webhooks adds `?trigger=<name>` to each URL and
 * reads it back as `event.trigger`.
 *
 * It sets no idempotency key: an `update` webhook delivers the same activity many times as it
 * changes, and each delivery is new. Handlers upsert by `activity.id`.
 */
export function ctmEventsWebhook(
  options: CtmEventsWebhookOptions
): WebhookDefinition<CtmCall, CtmClient> {
  return createCtmEventsWebhook(options, CTM_WEBHOOK)
}

/** Package-internal: the connector factory passes the subject written in its own vocabulary. */
export function createCtmEventsWebhook(
  options: CtmEventsWebhookOptions,
  subject: WebhookVerificationSubject
): WebhookDefinition<CtmCall, CtmClient> {
  const verification = resolveWebhookVerification(subject, options)
  warnUnverifiedWebhook(subject, verification)

  if (verification.credential) {
    assertUsableBasicAuth(verification.credential, subject)
  }

  return defineWebhook("events")
    .post()
    .json({ parse: parseActivity })
    .verify(({ request }) => {
      if (!options.credential) {
        return
      }

      verifyBasicAuth(options.credential, request.headers.get("authorization"))
    })
    .handle<CtmClient>(async ({ body, request, sixb, logger, client }) => {
      const trigger = new URL(request.url).searchParams.get("trigger")
      const event: CtmEvent = { trigger: trigger || null, activity: body }

      await options.onEvent({ event, request, sixb, logger, client })

      return { status: 200 }
    })
}

/** The activity's fields vary by kind and stage, so only its IDs are checked. */
function parseActivity(value: unknown): CtmEvent["activity"] {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.account_id !== "number") {
    throw new Error(
      '[SixbCtm] Unexpected webhook payload. Register the webhook with `hooktype: "call"`.'
    )
  }

  return value as unknown as CtmCall
}

/**
 * A credential object is truthy whatever it holds, so the union alone lets an unset environment
 * variable through: `{ username: process.env.USER!, password: process.env.PASSWORD! }` reaches
 * here as `undefined:undefined`, and the route then verifies against a credential anyone can
 * guess. Only the field values answer whether this webhook can actually be verified.
 */
function assertUsableBasicAuth(
  auth: CtmWebhookBasicAuth,
  subject: WebhookVerificationSubject
): void {
  if (isFilled(auth.username) && isFilled(auth.password)) {
    return
  }

  throw new UnverifiedWebhookError(
    `[${subject.connector}] ${subject.credentialOption} needs a non-empty username and password. ` +
      `An unset or empty value would leave this route accepting a credential anyone can guess, ` +
      `so pass ${subject.allowOption} if that is what you want.`
  )
}

function verifyBasicAuth(auth: CtmWebhookBasicAuth, header: string | null): void {
  if (!header?.startsWith("Basic ")) {
    throw new Error("[SixbCtm] Missing webhook basic auth.")
  }

  const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`
  const received = Buffer.from(header)
  const computed = Buffer.from(expected)

  if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
    throw new Error("[SixbCtm] Invalid webhook basic auth.")
  }
}

function isFilled(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0
}
