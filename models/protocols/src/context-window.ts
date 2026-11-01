import type { ModelProviderErrorReason } from "@sixb/core/models"

/**
 * Error codes providers give a request too long for the model: OpenAI's and Azure's. Anthropic's
 * `request_too_large` (HTTP 413) is a body past its byte limit, such as an attachment, which
 * summarizing the conversation does not shrink.
 */
const CONTEXT_WINDOW_CODES = new Set(["context_length_exceeded", "model_context_window_exceeded"])

/**
 * How providers word it when the code is generic (`invalid_request_error`): the Gateway's "Your
 * input exceeds the context window of this model", OpenAI's "maximum context length", Anthropic's
 * "prompt is too long" and "input length and `max_tokens` exceed context limit", Gemini's "input
 * token count (…) exceeds the maximum", Bedrock's "Input is too long for requested model". Never
 * "too many tokens", which rate limits say too.
 */
const CONTEXT_WINDOW_MESSAGE =
  /context[ _](?:window|length)[ _]exceeded|exceeds? the context (?:window|length)|exceeds? context limit|maximum context length|prompt is too long|input is too long|input token count[^.]*exceeds/i

/**
 * The reason a rejection carries when it says the request was too long for the model's context
 * window: an HTTP 400, or a stream error, whose code or message says so. Undefined for any other
 * rejection.
 */
export function contextWindowRejection(input: {
  readonly status?: number
  readonly code?: string
  readonly message?: string
}): { readonly reason: ModelProviderErrorReason } | undefined {
  if (input.status !== undefined && input.status !== 400) return undefined

  const coded = input.code !== undefined && CONTEXT_WINDOW_CODES.has(input.code)
  const worded = input.message !== undefined && CONTEXT_WINDOW_MESSAGE.test(input.message)
  return coded || worded ? { reason: "context-window-exceeded" } : undefined
}
