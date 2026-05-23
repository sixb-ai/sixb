import { WebhookValidationError } from "./errors"
import type {
  WebhookBodyParser,
  WebhookBodySchema,
  WebhookDefinition,
  WebhookHandlerContext,
  WebhookHandlerResult,
  WebhookIdempotencyKeyResolver,
  WebhookVerifyContext,
} from "./types"

type WebhookHandler<TBody, TClient> = (
  ctx: WebhookHandlerContext<TBody, TClient>
) => Promise<WebhookHandlerResult> | WebhookHandlerResult

type WebhookVerifyHandler = (ctx: WebhookVerifyContext) => Promise<void> | void

interface WebhookDraft<TBody> {
  readonly id: string
  readonly method: "POST"
  readonly body: WebhookBodyParser<TBody>
  readonly verify?: WebhookVerifyHandler
  readonly idempotencyKey?: WebhookIdempotencyKeyResolver<TBody>
}

/** Define an inbound webhook owned by a connector adapter. */
export function defineWebhook(id: string): WebhookMethodBuilder {
  assertNonEmpty(id, "Webhook id")
  return new WebhookMethodBuilder(id)
}

export class WebhookMethodBuilder<TClient = unknown> {
  constructor(private readonly id: string) {}

  post(): WebhookBodyBuilder<TClient> {
    return new WebhookBodyBuilder(this.id, "POST")
  }
}

export class WebhookBodyBuilder<TClient = unknown> {
  constructor(
    private readonly id: string,
    private readonly method: "POST"
  ) {}

  /**
   * Decode JSON and keep the handler body as unknown.
   *
   * Prefer `.json(schema)` for provider payloads that have a known shape.
   */
  json(): WebhookBuilder<unknown, TClient>
  /** Decode JSON, validate or normalize it at runtime, and infer the handler body. */
  json<TBody>(schema: WebhookBodySchema<TBody>): WebhookBuilder<TBody, TClient>
  json<TBody>(schema?: WebhookBodySchema<TBody>): WebhookBuilder<TBody | unknown, TClient> {
    if (schema !== undefined && typeof schema.parse !== "function") {
      throw new WebhookValidationError("[Sixb] Webhook JSON schema must provide parse(value).")
    }

    return new WebhookBuilder({
      id: this.id,
      method: this.method,
      body: {
        format: "json",
        parse(value: unknown) {
          return schema ? schema.parse(value) : value
        },
      },
    })
  }

  text(): WebhookBuilder<string, TClient> {
    return new WebhookBuilder({
      id: this.id,
      method: this.method,
      body: {
        format: "text",
        parse(value: unknown) {
          if (typeof value !== "string") {
            throw new Error("Expected webhook body to be text.")
          }

          return value
        },
      },
    })
  }

  raw(): WebhookBuilder<Uint8Array, TClient> {
    return new WebhookBuilder({
      id: this.id,
      method: this.method,
      body: {
        format: "raw",
        parse(value: unknown) {
          if (!(value instanceof Uint8Array)) {
            throw new Error("Expected webhook body to be raw bytes.")
          }

          return value
        },
      },
    })
  }
}

export class WebhookBuilder<TBody, TClient = unknown> {
  constructor(private readonly draft: WebhookDraft<TBody>) {}

  verify(verify: WebhookVerifyHandler): WebhookBuilder<TBody, TClient> {
    if (typeof verify !== "function") {
      throw new WebhookValidationError("[Sixb] Webhook verify must be a function.")
    }

    return new WebhookBuilder({
      ...this.draft,
      verify,
    })
  }

  idempotencyKey(resolver: WebhookIdempotencyKeyResolver<TBody>): WebhookBuilder<TBody, TClient> {
    if (typeof resolver !== "function") {
      throw new WebhookValidationError("[Sixb] Webhook idempotencyKey must be a function.")
    }

    return new WebhookBuilder({
      ...this.draft,
      idempotencyKey: resolver,
    })
  }

  handle<TNextClient = TClient>(
    handle: WebhookHandler<TBody, TNextClient>
  ): WebhookDefinition<TBody, TNextClient> {
    if (typeof handle !== "function") {
      throw new WebhookValidationError("[Sixb] Webhook handle must be a function.")
    }

    return {
      kind: "webhook",
      id: this.draft.id,
      method: this.draft.method,
      body: this.draft.body,
      idempotencyKey: this.draft.idempotencyKey,
      verify: this.draft.verify,
      handle,
    }
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new WebhookValidationError(`[Sixb] ${field} must not be empty.`)
  }
}
