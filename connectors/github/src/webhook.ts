import { createHmac, timingSafeEqual } from "node:crypto"
import type { WebhookDefinition } from "@sixb/core"
import { defineWebhook, warnUnverifiedWebhook } from "@sixb/core"
import type { GitHubClient } from "./types/client"
import type {
  GitHubEventHandler,
  GitHubWebhookEvent,
  GitHubWebhookEventName,
} from "./types/webhook"

interface GitHubWebhookOptions {
  readonly secret?: string
  readonly onEvent: GitHubEventHandler
}

/**
 * Inbound webhook for GitHub events.
 *
 * GitHub delivers every subscribed event to one URL, so this registers a single
 * route. When a secret is set it verifies the `X-Hub-Signature-256` HMAC over the
 * raw body, dedupes on the `X-GitHub-Delivery` id, and forwards each delivery to
 * `onEvent` with the event name taken from the `X-GitHub-Event` header.
 */
export function githubEventsWebhook(
  options: GitHubWebhookOptions
): WebhookDefinition<unknown, GitHubClient> {
  if (!options.secret) {
    warnUnverifiedWebhook({
      connector: "GitHub",
      header: "X-Hub-Signature-256",
      secretOption: "`secret` on githubEventsWebhook",
    })
  }

  return defineWebhook("events")
    .post()
    .json()
    .verify(({ request, rawBody }) => {
      if (!options.secret) {
        return
      }
      verifySignature(options.secret, rawBody, request.headers.get("x-hub-signature-256"))
    })
    .idempotencyKey(({ request }) => request.headers.get("x-github-delivery"))
    .handle<GitHubClient>(async ({ request, body, sixb, logger, client }) => {
      const name = request.headers.get("x-github-event")
      if (!name) {
        return
      }
      await options.onEvent({ event: toEvent(name, request, body), sixb, logger, client })
    })
}

function toEvent(name: string, request: Request, body: unknown): GitHubWebhookEvent {
  if (!isRecord(body)) {
    throw new Error("[SixbGitHub] Unexpected webhook payload.")
  }
  return {
    name: name as GitHubWebhookEventName,
    action: typeof body.action === "string" ? body.action : undefined,
    deliveryId: request.headers.get("x-github-delivery") ?? "",
    payload: body,
  } as GitHubWebhookEvent
}

function verifySignature(secret: string, rawBody: Uint8Array, signature: string | null): void {
  if (!signature) {
    throw new Error("[SixbGitHub] Missing X-Hub-Signature-256 header.")
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`
  const received = Buffer.from(signature)
  const computed = Buffer.from(expected)

  if (received.length !== computed.length || !timingSafeEqual(received, computed)) {
    throw new Error("[SixbGitHub] Invalid webhook signature.")
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
