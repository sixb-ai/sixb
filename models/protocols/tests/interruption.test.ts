import { expect, test } from "bun:test"
import type { JsonObject, LanguageModelStreamEvent } from "@sixb/core/models"
import { chatEvents } from "../src/chat"
import { messagesEvents } from "../src/messages"
import { responsesEvents } from "../src/responses"

// What a protocol says of a response its provider broke off: the reason `interrupted` tells the
// model loop it may make the call again. A request the provider rejects carries none.

const options = {
  providerId: "provider",
  modelId: "model",
  errorPrefix: "[Test]",
  usage: (raw: JsonObject | undefined) => ({ ...(raw === undefined ? {} : { raw }) }),
}

function body(values: readonly JsonObject[]): ReadableStream<Uint8Array> {
  const data = values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data))
      controller.close()
    },
  })
}

interface Protocol {
  readonly name: string
  readonly read: (values: readonly JsonObject[]) => AsyncIterable<LanguageModelStreamEvent>
  /** What starts a response. */
  readonly started: JsonObject
  /** The error event that fails it with `code`. */
  readonly failed: (code: string) => JsonObject
}

/** Each protocol, reading `body`, with what its error event looks like for a given code. */
const protocols: readonly Protocol[] = [
  {
    name: "Responses (AI Gateway, Azure)",
    read: (values: readonly JsonObject[]) =>
      responsesEvents(body(values), new AbortController().signal, options),
    started: { type: "response.created", response: { id: "response" } },
    failed: (code: string) => ({
      type: "response.failed",
      response: { error: { code, message: "The provider failed." } },
    }),
  },
  {
    name: "Messages (Anthropic, Azure)",
    read: (values: readonly JsonObject[]) =>
      messagesEvents(body(values), new AbortController().signal, options),
    started: { type: "message_start", message: { id: "message", usage: {} } },
    failed: (code: string) => ({ type: "error", error: { type: code, message: "Busy." } }),
  },
  {
    name: "Chat (Azure)",
    read: (values: readonly JsonObject[]) =>
      chatEvents(body(values), new AbortController().signal, options),
    started: { id: "chat", choices: [{ index: 0, delta: { content: "Hel" } }] },
    failed: (code: string) => ({ error: { code, message: "The server had an error." } }),
  },
]

/** The error a protocol's stream fails with, or the error its error event carries. */
async function failure(events: AsyncIterable<LanguageModelStreamEvent>): Promise<unknown> {
  try {
    for await (const event of events) if (event.type === "error") return event.error
  } catch (error) {
    return error
  }
  throw new Error("Expected the stream to fail.")
}

// Reproduce: drop streamInterruption from the protocol's error event; the overloaded provider's
// error then carries no reason, and the run fails.
test.each(
  protocols.flatMap((protocol) =>
    ["overloaded_error", "server_error", "rate_limit_exceeded"].map(
      (code) => [protocol.name, code, protocol] as const
    )
  )
)("%s: an error event saying the provider failed (%s) interrupts the response", async (_, code, protocol) => {
  const error = await failure(protocol.read([protocol.started, protocol.failed(code)]))

  expect(error).toMatchObject({ name: "ModelProviderError", code, reason: "interrupted" })
})

// Reproduce: map every coded error event to `interrupted`; a rejected request is then made again.
test.each(
  protocols.map((protocol) => [protocol.name, protocol] as const)
)("%s: an error event rejecting the request does not", async (_, protocol) => {
  const error = await failure(
    protocol.read([protocol.started, protocol.failed("invalid_request_error")])
  )

  expect(error).toMatchObject({ name: "ModelProviderError", code: "invalid_request_error" })
  expect((error as { reason?: unknown }).reason).toBeUndefined()
})

// Reproduce: drop STREAM_CLOSED_EARLY from the protocol's end-of-stream check; a stream cut before
// its terminal event then fails the run.
test.each(
  protocols.map((protocol) => [protocol.name, protocol] as const)
)("%s: a stream that closes before its terminal event is interrupted", async (_, protocol) => {
  const error = await failure(protocol.read([protocol.started]))

  expect(error).toMatchObject({ name: "ModelProviderError", reason: "interrupted" })
})
