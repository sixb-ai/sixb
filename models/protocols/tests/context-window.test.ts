import { expect, test } from "bun:test"
import { contextWindowRejection } from "../src/context-window"

// Reproduce: return undefined from contextWindowRejection; every case expecting the reason fails.
// Drop "exceeds? context limit" from CONTEXT_WINDOW_MESSAGE; Anthropic's input-and-max_tokens case
// fails.
test.each([
  // Vercel AI Gateway, as gpt-4o-mini answered a 776 KB request.
  [{ status: 400, message: "Your input exceeds the context window of this model" }],
  [
    {
      status: 400,
      code: "context_length_exceeded",
      message: "This model's maximum context length is 128000 tokens.",
    },
  ],
  [
    {
      status: 400,
      code: "invalid_request_error",
      message: "prompt is too long: 215000 tokens > 200000 maximum",
    },
  ],
  [
    {
      status: 400,
      code: "invalid_request_error",
      message: "input length and `max_tokens` exceed context limit: 187254 + 20000 > 204798",
    },
  ],
  [
    {
      status: 400,
      message: "The input token count (1200000) exceeds the maximum number of tokens allowed",
    },
  ],
  [{ status: 400, message: "Input is too long for requested model." }],
  // A stream error carries no status.
  [{ code: "context_length_exceeded" }],
])("names a request too long for the model's context window: %j", (rejection) => {
  expect(contextWindowRejection(rejection)).toEqual({ reason: "context-window-exceeded" })
})

test.each([
  [{ status: 400, code: "invalid_request_error", message: "tools.0.name is invalid" }],
  [{ status: 429, message: "Too many tokens per minute: rate limit reached" }],
  [{ status: 500, code: "context_length_exceeded" }],
  [{ status: 401, message: "Invalid API key" }],
  // Bedrock's throttling, as a stream error: a rate limit, not the window.
  [{ message: "Too many tokens, please wait before trying again." }],
  [{ status: 400, message: "Too many input tokens per minute." }],
  // Anthropic's body size limit, such as an attachment: summarizing does not shrink it.
  [
    {
      status: 413,
      code: "request_too_large",
      message: "Request exceeds the maximum allowed number of bytes.",
    },
  ],
])("leaves any other rejection alone: %j", (rejection) => {
  // Reproduce: restore "too many (?:input )?tokens" to CONTEXT_WINDOW_MESSAGE, or 413 and
  // request_too_large to the accepted rejections; the rate limits or the body size then pass for
  // the window.
  expect(contextWindowRejection(rejection)).toBeUndefined()
})
