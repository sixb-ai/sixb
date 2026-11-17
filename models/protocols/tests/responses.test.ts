import { expect, test } from "bun:test"
import type { JsonObject, ModelAssistantPart, ModelMessage } from "@sixb/core/models"
import { responsesEvents, responsesInput, responsesUsage } from "../src/responses"

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

// Removal proof: prioritize sawToolCall over response status in finishReason.
test.each([
  ["max_output_tokens", "length"],
  ["content_filter", "content-filter"],
  ["future_reason", "other"],
])("preserves incomplete response reason %s even after tool arguments close", async (reason, expected) => {
  const events = []
  for await (const event of responsesEvents(
    stream([
      {
        type: "response.output_item.added",
        item: { id: "tool", type: "function_call", call_id: "call", name: "act", arguments: "" },
      },
      { type: "response.function_call_arguments.done", item_id: "tool", arguments: "{}" },
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason },
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      },
    ]),
    new AbortController().signal,
    { providerId: "test", modelId: "test", errorPrefix: "[Test]" }
  ))
    events.push(event)
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    finishReason: expected,
    usage: { inputTokens: 1, outputTokens: 2 },
  })
})

// Regression proof: remove the providerId checks in responses/input.ts. Foreign encrypted
// state then enters the request and this test fails. No Azure/Gateway credentials are involved.
test("round-trips encrypted reasoning and phases under independent provider identities", async () => {
  for (const providerId of ["first", "second"]) {
    const reasoning = {
      type: "reasoning",
      id: "reason",
      encrypted_content: "opaque",
      summary: [{ type: "summary_text", text: "réfléchir" }],
    }
    const content: ModelAssistantPart[] = []
    let textProviderData: Extract<ModelAssistantPart, { type: "text" }>["providerData"]
    let visible = ""
    const events = []
    for await (const event of responsesEvents(
      stream([
        { type: "response.created", response: { id: "resp", model: "deployment" } },
        { type: "response.output_item.done", item: reasoning },
        { type: "response.output_text.delta", item_id: "message", delta: "Voilà" },
        { type: "response.output_text.done", item_id: "message", text: "Voilà" },
        {
          type: "response.output_item.done",
          item: { type: "message", id: "message", phase: "commentary" },
        },
        {
          type: "response.completed",
          response: {
            id: "resp",
            status: "completed",
            output: [reasoning],
            usage: { input_tokens: 10, output_tokens: 5 },
            gateway: { cost: "99", provider: "must-not-be-interpreted" },
          },
        },
      ]),
      new AbortController().signal,
      {
        providerId,
        modelId: "deployment",
        requestId: "request",
        errorPrefix: "[TestProvider]",
      }
    )) {
      events.push(event)
      if (event.type === "provider-state") content.push(event)
      if (event.type === "text-start") textProviderData = event.providerData
      if (event.type === "text-delta") visible += event.delta
      if (event.type === "text-end")
        content.push({ type: "text", text: visible, providerData: textProviderData })
    }
    expect(events.filter((event) => event.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", id: "reason:reasoning:0", delta: "réfléchir" },
    ])
    expect(events.at(-1)).toEqual({
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "completed",
      usage: { inputTokens: 10, outputTokens: 5, raw: { input_tokens: 10, output_tokens: 5 } },
    })
    expect(events.filter((event) => event.type === "response-metadata").at(-1)).toEqual({
      type: "response-metadata",
      providerIds: { requestId: "request", responseId: "resp" },
    })
    content.push({
      type: "provider-state",
      providerId: "foreign",
      data: { item: { type: "reasoning", encrypted_content: "foreign" } },
    })
    // Durable histories serialize opaque content; no module identity or in-memory state is needed.
    const replay: ModelAssistantPart[] = JSON.parse(JSON.stringify(content))
    expect(responsesInput([{ role: "assistant", content: replay }], providerId)).toEqual([
      reasoning,
      { role: "assistant", content: [{ type: "output_text", text: "Voilà" }], phase: "commentary" },
    ])
  }
})

test("preserves reported counters without importing a provider's missing-usage assumptions", () => {
  expect(responsesUsage(undefined)).toEqual({})
  const raw = {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
  }
  expect(responsesUsage(raw)).toEqual({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 3,
    reasoningOutputTokens: 2,
    raw,
  })
  expect(responsesUsage({ input_tokens: -1, output_tokens: 1.5 })).toEqual({
    raw: { input_tokens: -1, output_tokens: 1.5 },
  })
})

test("rejects an unterminated stream with the calling provider's diagnostic identity", async () => {
  const consume = async () => {
    for await (const _event of responsesEvents(
      stream([{ type: "response.output_text.delta", item_id: "message", delta: "partial" }]),
      new AbortController().signal,
      {
        providerId: "independent",
        modelId: "deployment",
        requestId: "request",
        errorPrefix: "[Independent]",
      }
    )) {
      /* consume to EOF */
    }
  }
  await expect(consume()).rejects.toMatchObject({
    name: "ModelProviderError",
    providerId: "independent",
    modelId: "deployment",
    requestId: "request",
    message: "[Independent] Provider stream ended without a terminal response event.",
  })
})

// Removal proof: drop the trailing-reasoning loop in responsesInput; the request then carries a
// reasoning item without its following item, which Responses rejects.
test("does not replay reasoning an answer cut short ended on", () => {
  const reasoning = (id: string): ModelAssistantPart => ({
    type: "provider-state",
    providerId: "test",
    data: { item: { type: "reasoning", id, encrypted_content: "opaque" } },
  })
  const functionCall = { type: "function_call", call_id: "call", name: "act", arguments: "{}" }
  const question = { role: "user" as const, content: [{ type: "text" as const, text: "Go" }] }
  const input = responsesInput(
    [
      question,
      // The output limit was reached while reasoning.
      { role: "assistant", content: [{ type: "reasoning", text: "Hmm" }, reasoning("alone")] },
      question,
      {
        role: "assistant",
        content: [
          reasoning("led"),
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "act",
            input: {},
            providerData: { test: { item: functionCall } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "act",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      // The tool call this reasoning led to was cut short and dropped.
      { role: "assistant", content: [reasoning("dropped-call")] },
      question,
    ],
    "test"
  )
  const go = { role: "user", content: [{ type: "input_text", text: "Go" }] }
  expect(input).toEqual([
    go,
    go,
    { type: "reasoning", id: "led", encrypted_content: "opaque" },
    functionCall,
    { type: "function_call_output", call_id: "call", output: "ok" },
    go,
  ])
})

// Removal proof: serialize JSON tool outputs and synthesized arguments with JSON.stringify in
// responses/input.ts; the replay from Postgres `jsonb` key order prints other bytes.
test("serializes JSON tool outputs and synthesized arguments the same whatever their key order", () => {
  const turn = (output: JsonObject, input: JsonObject): ModelMessage[] => [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call", toolName: "read", input }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "read",
          output: { type: "json", value: output },
        },
      ],
    },
  ]
  const live = turn(
    { path: "a.ts", content: "x", startLine: 1, endLine: 2, truncated: false },
    { path: "a.ts", offset: 1, limit: 2 }
  )
  const fromJsonb = turn(
    { path: "a.ts", content: "x", endLine: 2, startLine: 1, truncated: false },
    { path: "a.ts", limit: 2, offset: 1 }
  )

  expect(JSON.stringify(responsesInput(fromJsonb, "test"))).toBe(
    JSON.stringify(responsesInput(live, "test"))
  )
  expect(responsesInput(live, "test")).toEqual([
    {
      type: "function_call",
      call_id: "call",
      name: "read",
      arguments: '{"limit":2,"offset":1,"path":"a.ts"}',
    },
    {
      type: "function_call_output",
      call_id: "call",
      output: '{"content":"x","endLine":2,"path":"a.ts","startLine":1,"truncated":false}',
    },
  ])
})

test("names a failed response about the context window as one", async () => {
  const events = []
  for await (const event of responsesEvents(
    stream([
      {
        type: "response.failed",
        response: {
          error: {
            code: "context_length_exceeded",
            message: "Your input exceeds the context window of this model.",
          },
        },
      },
    ]),
    new AbortController().signal,
    { providerId: "test", modelId: "test", errorPrefix: "[Test]" }
  ))
    events.push(event)
  const failed = events.find((event) => event.type === "error")
  expect(failed?.type === "error" ? failed.error : undefined).toMatchObject({
    name: "ModelProviderError",
    code: "context_length_exceeded",
    reason: "context-window-exceeded",
  })
})

// One provider, such as AI Gateway, fronts several models, and a model rejects another's encrypted
// reasoning: a thread that moved from an OpenAI model to Gemini failed every turn with "Corrupted
// thought signature". Removal proof: drop the fromModel check in responsesInput; the OpenAI
// reasoning and function_call items reach the Gemini request.
test("replays a native item only to the model that produced it", async () => {
  const reasoning = { type: "reasoning", id: "rs-1", encrypted_content: "openai-signed" }
  const call = {
    type: "function_call",
    id: "fc-item",
    call_id: "call-1",
    name: "echo",
    arguments: '{"value":"x"}',
  }
  const events = []
  for await (const event of responsesEvents(
    stream([
      { type: "response.created", response: { id: "resp", model: "openai/gpt" } },
      { type: "response.output_item.done", item: reasoning },
      { type: "response.output_item.done", item: call },
      {
        type: "response.completed",
        response: { id: "resp", status: "completed", output: [reasoning, call] },
      },
    ]),
    new AbortController().signal,
    { providerId: "gateway", modelId: "openai/gpt", errorPrefix: "[TestProvider]" }
  )) {
    events.push(event)
  }
  const state = events.find((event) => event.type === "provider-state")
  const ended = events.find((event) => event.type === "tool-input-end")
  if (state?.type !== "provider-state" || ended?.type !== "tool-input-end") {
    throw new Error("Expected the reasoning and the call to be kept for replay.")
  }
  const history: ModelMessage[] = JSON.parse(
    JSON.stringify([
      {
        role: "assistant",
        content: [
          state,
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "echo",
            input: { value: "x" },
            providerData: ended.providerData,
          },
        ],
      },
    ])
  )

  // The same model gets its own reasoning and native call back.
  expect(responsesInput(history, "gateway", "openai/gpt")).toEqual([reasoning, call])
  // Another model behind the same provider gets the call, portably, and no reasoning.
  expect(responsesInput(history, "gateway", "google/gemini")).toEqual([
    { type: "function_call", call_id: "call-1", name: "echo", arguments: '{"value":"x"}' },
  ])
  // Items recorded before their model was, and callers that name none, replay as before.
  const untagged: ModelMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "provider-state", providerId: "gateway", data: { item: reasoning } },
        { type: "text", text: "Done" },
      ],
    },
  ]
  expect(responsesInput(untagged, "gateway", "google/gemini")).toEqual([
    reasoning,
    { role: "assistant", content: [{ type: "output_text", text: "Done" }] },
  ])
  expect(responsesInput(history, "gateway")).toEqual([reasoning, call])
})
