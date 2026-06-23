import type {
  WebhookDefinition,
  WebhookHandlerContext,
  WebhookHandlerResult,
  WebhookIdempotencyKeyResolver,
  WebhookVerifyContext,
} from "@sixb/core"
import type { TeamleaderClient } from "./types"

type TeamleaderWebhookHandler<TBody> = (
  context: WebhookHandlerContext<TBody, TeamleaderClient>
) => Promise<WebhookHandlerResult> | WebhookHandlerResult

type TeamleaderWebhookVerifyHandler = (context: WebhookVerifyContext) => Promise<void> | void

export function defineTeamleaderWebhook<TBody = unknown>(
  id: string
): TeamleaderWebhookBuilder<TBody> {
  return new TeamleaderWebhookBuilder<TBody>({
    id,
    method: "POST",
    body: {
      format: "json",
      parse(value: unknown): TBody {
        return value as TBody
      },
    },
  })
}

interface TeamleaderWebhookDraft<TBody> {
  readonly id: string
  readonly method: "POST"
  readonly body: WebhookDefinition<TBody, TeamleaderClient>["body"]
  readonly verify?: TeamleaderWebhookVerifyHandler
  readonly idempotencyKey?: WebhookIdempotencyKeyResolver<TBody>
}

export class TeamleaderWebhookBuilder<TBody = unknown> {
  constructor(private readonly draft: TeamleaderWebhookDraft<TBody>) {
    assertNonEmpty(draft.id, "Webhook id")
  }

  verify(verify: TeamleaderWebhookVerifyHandler): TeamleaderWebhookBuilder<TBody> {
    if (typeof verify !== "function") {
      throw new Error("[SixbTeamleader] Webhook verify must be a function.")
    }

    return new TeamleaderWebhookBuilder({
      ...this.draft,
      verify,
    })
  }

  idempotencyKey(resolver: WebhookIdempotencyKeyResolver<TBody>): TeamleaderWebhookBuilder<TBody> {
    if (typeof resolver !== "function") {
      throw new Error("[SixbTeamleader] Webhook idempotencyKey must be a function.")
    }

    return new TeamleaderWebhookBuilder({
      ...this.draft,
      idempotencyKey: resolver,
    })
  }

  handle(handle: TeamleaderWebhookHandler<TBody>): WebhookDefinition<TBody, TeamleaderClient> {
    if (typeof handle !== "function") {
      throw new Error("[SixbTeamleader] Webhook handle must be a function.")
    }

    return {
      kind: "webhook",
      id: this.draft.id,
      method: this.draft.method,
      body: this.draft.body,
      verify: this.draft.verify,
      idempotencyKey: this.draft.idempotencyKey,
      handle,
    }
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`[SixbTeamleader] ${field} must not be empty.`)
  }
}
