/**
 * Base error for webhook-run storage operations.
 */
export type WebhookRunErrorCode =
  | "delivery_conflict"
  | "duplicate_run"
  | "invalid_execution"
  | "invalid_transition"
  | "not_found"

export class WebhookRunError extends Error {
  readonly name = "WebhookRunError"

  constructor(
    message: string,
    readonly code?: WebhookRunErrorCode
  ) {
    super(message)
  }
}
