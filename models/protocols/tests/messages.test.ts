import { expect, test } from "bun:test"
import type {
  JsonObject,
  LanguageModelStreamEvent,
  ModelAssistantPart,
  ModelMessage,
} from "@sixb/core/models"
import { messagesEvents, messagesInput } from "../src/messages"

const options = {
  providerId: "independent",
  modelId: "deployment",
  requestId: "request",
  errorPrefix: "[Independent]",
}

function stream(events: readonly JsonObject[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")
  )
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    },
  })
}

async function collect(
  events: AsyncIterable<LanguageModelStreamEvent>
): Promise<LanguageModelStreamEvent[]> {
  const collected = []
  for await (const event of events) collected.push(event)
  return collected
}

// Regression proof: replace signature accumulation in messages/stream.ts with assignment.
// The signed block (and its durable replay) then retains only the last signature fragment.
// Removing the providerId check in messages/input.ts also fails on foreign opaque state.
test("replays complete signed thinking, redacted blocks, and tools under independent identities", async () => {
  for (const providerId of ["first", "second"]) {
    const events = await collect(
      messagesEvents(
        stream([
          { type: "message_start", message: { id: "msg", model: "deployment", usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Réfléchir" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "signed-" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "opaque" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "redacted_thinking", data: "redacted" },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "content_block_start",
            index: 2,
            content_block: { type: "tool_use", id: "call", name: "weather", input: {} },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '{"city":' },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '"Paris"}' },
          },
          { type: "content_block_stop", index: 2 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 8 },
          },
          { type: "message_stop" },
        ]),
        new AbortController().signal,
        { ...options, providerId }
      )
    )

    const content: ModelAssistantPart[] = []
    for (const event of events) {
      if (event.type === "reasoning-end")
        content.push({ type: "reasoning", text: "Réfléchir", providerData: event.providerData })
      if (event.type === "provider-state") content.push(event)
      if (event.type === "tool-input-end")
        content.push({
          type: "tool-call",
          toolCallId: event.id,
          toolName: "weather",
          input: { city: "Paris" },
          providerData: event.providerData,
        })
    }
    expect(events).toContainEqual({ type: "reasoning-delta", id: "content:0", delta: "Réfléchir" })
    expect(
      events
        .filter((event) => event.type === "tool-input-delta")
        .map((event) => event.delta)
        .join("")
    ).toBe('{"city":"Paris"}')
    expect(events).toContainEqual({
      type: "response-metadata",
      id: "msg",
      modelId: "deployment",
      providerIds: { requestId: "request", responseId: "msg" },
    })
    expect(events.at(-1)).toMatchObject({
      type: "finish",
      finishReason: "tool-calls",
      usage: { outputTokens: 8 },
    })
    content.push(
      {
        type: "provider-state",
        providerId: "foreign",
        data: { block: { type: "redacted_thinking", data: "foreign" } },
      },
      {
        type: "reasoning",
        text: "foreign thinking",
        providerData: {
          foreign: {
            block: { type: "thinking", signature: "foreign", thinking: "foreign thinking" },
          },
        },
      }
    )
    const history: ModelMessage[] = [
      { role: "assistant", content },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "weather",
            output: { type: "error-json", value: { error: "unavailable" } },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Try later." }] },
    ]
    const restored: ModelMessage[] = JSON.parse(JSON.stringify(history))
    expect(messagesInput(restored, providerId, "[Test]")).toEqual({
      system: [],
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Réfléchir", signature: "signed-opaque" },
            { type: "redacted_thinking", data: "redacted" },
            { type: "tool_use", id: "call", name: "weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call",
              content: '{"error":"unavailable"}',
              is_error: true,
            },
            { type: "text", text: "Try later." },
          ],
        },
      ],
    })
  }
})

test("merges cumulative usage snapshots, including partial cache TTL details and raw meters", async () => {
  const events = await collect(
    messagesEvents(
      stream([
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 3,
              cache_creation: { ephemeral_5m_input_tokens: 2 },
              output_tokens: 1,
              server_tool_use: { web_search_requests: 1 },
            },
          },
        },
        {
          type: "message_delta",
          usage: { output_tokens: 7, cache_creation: { ephemeral_1h_input_tokens: 4 } },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: {
            input_tokens: null,
            output_tokens: 9,
            output_tokens_details: { thinking_tokens: 2 },
          },
        },
        { type: "message_stop" },
      ]),
      new AbortController().signal,
      options
    )
  )
  expect(events.at(-1)).toEqual({
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "end_turn",
    usage: {
      inputTokens: 21,
      uncachedInputTokens: 12,
      cacheReadInputTokens: 3,
      cacheWriteInputTokens: 6,
      cacheWrite5mInputTokens: 2,
      cacheWrite1hInputTokens: 4,
      outputTokens: 9,
      reasoningOutputTokens: 2,
      textOutputTokens: 7,
      raw: {
        input_tokens: 12,
        cache_read_input_tokens: 3,
        cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 4 },
        output_tokens: 9,
        output_tokens_details: { thinking_tokens: 2 },
        server_tool_use: { web_search_requests: 1 },
      },
    },
  })
})

test("maps portable documents and provider-owned system blocks without mutating input", () => {
  const system = { type: "text", text: "Policy", cache_control: { type: "ephemeral" } }
  const history: ModelMessage[] = [
    { role: "system", content: "Policy", providerData: { independent: { block: system } } },
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "application/pdf",
          data: new URL("data:application/pdf;base64,cGRm"),
        },
        { type: "file", mediaType: "image/png", data: new URL("https://example.com/image.png") },
      ],
    },
    { role: "user", content: [{ type: "text", text: "Read these." }] },
  ]
  const before = JSON.stringify(history)
  expect(messagesInput(history, options.providerId, options.errorPrefix)).toEqual({
    system: [system],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "cGRm" },
          },
          { type: "image", source: { type: "url", url: "https://example.com/image.png" } },
          { type: "text", text: "Read these." },
        ],
      },
    ],
  })
  expect(JSON.stringify(history)).toBe(before)
})

const malformedStreams: [JsonObject[], string][] = [
  [[], "Provider stream ended without a terminal message event."],
  [
    [{ type: "content_block_delta", index: 0 }],
    "Received 'content_block_delta' before message_start.",
  ],
  [
    [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } },
      { type: "message_stop" },
    ],
    "Message stopped with open content blocks.",
  ],
]

test.each(malformedStreams)("rejects malformed Messages streams (%j)", async (wire, message) => {
  await expect(
    collect(messagesEvents(stream(wire), new AbortController().signal, options))
  ).rejects.toMatchObject({
    name: "ModelProviderError",
    providerId: "independent",
    modelId: "deployment",
    requestId: "request",
    message: `[Independent] ${message}`,
  })
})

test("preserves the calling provider's error identity and closes an abandoned HTTP body", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"type":"error","error":{"type":"overloaded_error","message":"Busy"}}\n\n'
        )
      )
    },
    cancel() {
      cancelled = true
    },
  })
  for await (const event of messagesEvents(body, new AbortController().signal, options)) {
    expect(event).toMatchObject({
      type: "error",
      error: {
        name: "ModelProviderError",
        providerId: "independent",
        modelId: "deployment",
        requestId: "request",
        code: "overloaded_error",
        message: "[Independent] Busy",
      },
    })
    break
  }
  expect(cancelled).toBe(true)
  expect(body.locked).toBe(false)
})
