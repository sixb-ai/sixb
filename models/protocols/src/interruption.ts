import type { ModelProviderErrorReason } from "@sixb/core/models"

/**
 * Error codes a stream's error event gives when the provider failed on its side, not on the
 * request: Anthropic's `overloaded_error`, `api_error`, `rate_limit_error` and `timeout_error`
 * (Azure's Messages route too), OpenAI's and Azure's `server_error` and `rate_limit_exceeded`, and
 * the Gateway's `internal_server_error` and `service_unavailable`.
 */
const INTERRUPTION_CODES = new Set([
  "overloaded_error",
  "api_error",
  "rate_limit_error",
  "timeout_error",
  "server_error",
  "rate_limit_exceeded",
  "internal_server_error",
  "service_unavailable",
])

/**
 * The reason a stream's error event carries when the provider broke off a response it had
 * started, for a reason of its own: the same request may succeed when it is made again. Undefined
 * for any other error, such as a request it rejects.
 */
export function streamInterruption(input: {
  readonly code?: string
}): { readonly reason: ModelProviderErrorReason } | undefined {
  return input.code !== undefined && INTERRUPTION_CODES.has(input.code)
    ? { reason: "interrupted" }
    : undefined
}

/** A stream that closed before its terminal event broke off as a lost connection does. */
export const STREAM_CLOSED_EARLY = { reason: "interrupted" } as const
