import { SixbError, type SixbErrorOptions } from "../../errors"

/** Webhook-run storage refusing a read or a write. */
export type WebhookRunErrorCode =
  | "webhook.run_not_found"
  | "storage.conflict"
  | "runtime.invalid_input"

export class WebhookRunError extends SixbError {
  override readonly name = "WebhookRunError"

  // biome-ignore lint/complexity/noUselessConstructor: it narrows `code` to this store's set.
  constructor(code: WebhookRunErrorCode, message: string, options?: SixbErrorOptions) {
    super(code, message, options)
  }
}
