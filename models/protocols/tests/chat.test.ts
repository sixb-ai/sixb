import { expect, test } from "bun:test"
import type { JsonObject, LanguageModelStreamEvent, ModelMessage } from "@sixb/core/models"
import { chatEvents, chatInput } from "../src/chat"

function body(
  values: readonly (JsonObject | string)[],
  cancel?: () => void
): ReadableStream<Uint8Array> {
  const data = new TextEncoder().encode(
    values
      .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`)
      .join("")
  )
  return new ReadableStream({
    start(controller) {
      for (const byte of data) controller.enqueue(Uint8Array.of(byte))
      if (!cancel) controller.close()
    },
    cancel,
  })
}
const options = {
  providerId: "provider",
  modelId: "deployment",
  errorPrefix: "[Test]",
  requestId: "request",
  usage: (raw: JsonObject | undefined) => ({ raw }),
}
const chunk = (delta: JsonObject = {}, finish: string | null = null): JsonObject => ({
  id: "response",
  model: "publisher-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
})
async function events(
  values: readonly (JsonObject | string)[]
): Promise<LanguageModelStreamEvent[]> {
  const result: LanguageModelStreamEvent[] = []
  for await (const event of chatEvents(body(values), new AbortController().signal, options))
    result.push(event)
  return result
}

// Regression proof: finalize at choice.finish_reason instead of [DONE]. This drops the
// later usage-only chunk and asynchronous filter annotations asserted below.
test("consumes usage and delayed annotations after choice completion across byte boundaries", async () => {
  const result = await events([
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    {
      choices: [],
      prompt_filter_results: [
        { prompt_index: 0, content_filter_results: { hate: { filtered: false } } },
      ],
    },
    chunk({ role: "assistant", reasoning_content: "Réfléchir" }),
    chunk({ content: "世界" }),
    chunk({}, "stop"),
    {
      choices: [
        {
          index: 0,
          content_filter_results: { violence: { filtered: false } },
          content_filter_offsets: { start_offset: 0, end_offset: 2, check_offset: 2 },
        },
      ],
    },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    "[DONE]",
  ])
  expect(result.filter((event) => event.type === "text-delta")).toEqual([
    { type: "text-delta", id: "text", delta: "世界" },
  ])
  expect(result).toContainEqual({
    type: "reasoning-end",
    id: "reasoning",
    providerData: { provider: { reasoning_content: "Réfléchir" } },
  })
  expect(result.at(-1)).toMatchObject({
    type: "finish",
    finishReason: "stop",
    usage: { raw: { prompt_tokens: 12, completion_tokens: 7 } },
    route: { modelId: "publisher-model" },
    providerData: {
      provider: {
        annotations: [
          {
            prompt_filter_results: [
              { prompt_index: 0, content_filter_results: { hate: { filtered: false } } },
            ],
          },
          {
            choice: 0,
            content_filter_results: { violence: { filtered: false } },
            content_filter_offsets: { start_offset: 0, end_offset: 2, check_offset: 2 },
          },
        ],
      },
    },
  })
})

// Live Foundry DeepSeek-V3.2 sends role:null on text and tool continuation chunks.
// Regression proof: remove the null exclusion from delta.role validation in chat/stream.ts.
test("accepts null role placeholders in DeepSeek text and tool deltas", async () => {
  const result = await events([
    chunk({ role: "assistant", content: "" }),
    chunk({ role: null, content: "Checking.", reasoning_content: null, tool_calls: null }),
    chunk({
      role: null,
      content: null,
      tool_calls: [
        {
          index: 0,
          id: "call-a",
          type: "function",
          function: { name: "check", arguments: "" },
        },
      ],
    }),
    chunk({
      role: null,
      tool_calls: [
        {
          index: 0,
          id: null,
          type: "function",
          function: { name: null, arguments: '{"code":1}' },
        },
      ],
    }),
    chunk({ reasoning_content: null }, "tool_calls"),
    { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } },
    "[DONE]",
  ])
  expect(result).toContainEqual({ type: "text-delta", id: "text", delta: "Checking." })
  expect(result).toContainEqual({
    type: "tool-call",
    toolCallId: "call-a",
    toolName: "check",
    input: '{"code":1}',
  })
  expect(result.at(-1)).toMatchObject({ type: "finish", usage: { raw: { completion_tokens: 10 } } })
})

test("assembles interleaved tool arguments and fragmented names using stable indices", async () => {
  const result = await events([
    chunk({ tool_calls: [{ index: 0, id: "call-a", type: "function" }] }),
    chunk({
      tool_calls: [
        { index: 0, id: "call-a", type: "function", function: { name: "che", arguments: "{" } },
        { index: 1, id: "call-b", type: "function", function: { name: "other", arguments: "{}" } },
      ],
    }),
    chunk({ tool_calls: [{ index: 0, function: { name: "ck", arguments: '"x":1}' } }] }),
    chunk({}, "tool_calls"),
    { choices: [], usage: { completion_tokens: 5 } },
    "[DONE]",
  ])
  expect(result.filter((event) => event.type === "tool-call")).toEqual([
    { type: "tool-call", toolCallId: "call-a", toolName: "check", input: '{"x":1}' },
    { type: "tool-call", toolCallId: "call-b", toolName: "other", input: "{}" },
  ])
  expect(result.at(-1)).toMatchObject({
    finishReason: "tool-calls",
    usage: { raw: { completion_tokens: 5 } },
  })
})

test.each([
  "length",
  "content_filter",
])("does not execute truncated or filtered tool calls (%s)", async (reason) => {
  const result = await events([
    chunk({ tool_calls: [{ index: 0, function: { name: "half", arguments: "{" } }] }),
    chunk({}, reason),
    { choices: [], usage: { completion_tokens: 4 } },
    "[DONE]",
  ])
  expect(result.some((event) => event.type === "tool-call")).toBe(false)
  expect(result.at(-1)).toMatchObject({
    finishReason: reason === "length" ? "length" : "content-filter",
    usage: { raw: { completion_tokens: 4 } },
  })
})

test("preserves refusal metadata without emitting it as ordinary answer text", async () => {
  const result = await events([chunk({ refusal: "No." }), chunk({}, "stop"), "[DONE]"])
  expect(result.some((event) => event.type === "text-delta")).toBe(false)
  expect(result.at(-1)).toMatchObject({
    finishReason: "content-filter",
    providerData: { provider: { refusal: "No." } },
  })
})

const invalid: [string, (JsonObject | string)[]][] = [
  ["missing done", [chunk({}, "stop")]],
  ["missing finish", [chunk({ content: "unfinished" }), "[DONE]"]],
  [
    "multiple choices",
    [
      {
        choices: [
          { index: 0, delta: {} },
          { index: 1, delta: {} },
        ],
      },
    ],
  ],
  ["wrong choice", [{ choices: [{ index: 1, delta: {} }] }]],
  ["missing choices", [{}]],
  ["bad json", ["{broken"]],
  ["non-object", ["[]"]],
  ["content after finish", [chunk({}, "stop"), chunk({ content: "late" })]],
  ["duplicate finish", [chunk({}, "stop"), chunk({}, "stop")]],
  ["missing tool", [chunk({}, "tool_calls"), "[DONE]"]],
  [
    "missing tool id",
    [
      chunk({ tool_calls: [{ index: 0, function: { name: "tool", arguments: "{}" } }] }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ],
  ],
  [
    "conflicting tool id",
    [
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "a" } }] }),
      chunk({ tool_calls: [{ index: 0, id: "b", function: { arguments: "{}" } }] }),
    ],
  ],
  [
    "duplicate tool id",
    [
      chunk({
        tool_calls: [
          { index: 0, id: "a", function: { name: "a", arguments: "{}" } },
          { index: 1, id: "a", function: { name: "b", arguments: "{}" } },
        ],
      }),
      chunk({}, "tool_calls"),
      "[DONE]",
    ],
  ],
  ["legacy functions", [chunk({ function_call: { name: "a" } })]],
  ["changed response", [chunk(), { ...chunk(), id: "other" }]],
  ["changed model", [chunk(), { ...chunk(), model: "other" }]],
  ["invalid usage", [{ choices: [], usage: [] }]],
]
test.each(invalid)("rejects malformed Chat stream: %s", async (_name, values) => {
  await expect(events(values)).rejects.toMatchObject({
    name: "ModelProviderError",
    providerId: "provider",
    modelId: "deployment",
    requestId: "request",
  })
})

test("treats an error after a choice finish as failure, not a completed answer", async () => {
  const result = await events([
    chunk({ content: "partial" }, "stop"),
    { error: { code: "content_filter", message: "blocked" } },
  ])
  expect(result.some((event) => event.type === "finish")).toBe(false)
  expect(result.at(-1)).toMatchObject({
    type: "error",
    error: { code: "content_filter", message: "[Test] blocked", requestId: "request" },
  })
})

test("cancels incomplete bodies on consumer return and abort", async () => {
  let cancelled = 0
  const controller = new AbortController()
  const iterator = chatEvents(
    body([chunk({ content: "first" })], () => {
      cancelled++
    }),
    controller.signal,
    options
  )
  for await (const event of iterator) if (event.type === "text-delta") break
  expect(cancelled).toBe(1)
  const consume = async () => {
    for await (const event of chatEvents(
      body([chunk({ content: "second" })], () => {
        cancelled++
      }),
      controller.signal,
      options
    ))
      if (event.type === "text-delta") controller.abort(new Error("cancelled"))
  }
  await expect(consume()).rejects.toThrow("cancelled")
  expect(cancelled).toBe(2)
})

test("serializes portable history and isolates reasoning to same-provider current-turn tool continuation", () => {
  const messages: ModelMessage[] = [
    { role: "system" as const, content: "Rules" },
    { role: "user" as const, content: [{ type: "text" as const, text: "Question" }] },
    {
      role: "assistant" as const,
      content: [
        {
          type: "reasoning" as const,
          text: "portable",
          providerData: { provider: { reasoning_content: "native" } },
        },
        {
          type: "reasoning" as const,
          text: "foreign",
          providerData: { other: { reasoning_content: "foreign-native" } },
        },
        { type: "tool-call" as const, toolCallId: "call", toolName: "check", input: { x: 1 } },
      ],
    },
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "call",
          toolName: "check",
          output: { type: "error-json" as const, value: { error: "failed" } },
        },
      ],
    },
  ]
  const config = {
    providerId: "provider",
    errorPrefix: "[Test]",
    reasoningReplay: "tool-continuation" as const,
    systemRole: "developer" as const,
  }
  const result = chatInput(messages, config)
  expect(result[0]).toEqual({ role: "developer", content: "Rules" })
  expect(result[2]).toMatchObject({
    reasoning_content: "native",
    content: null,
    tool_calls: [{ id: "call", function: { arguments: '{"x":1}' } }],
  })
  expect(result[3]).toEqual({ role: "tool", tool_call_id: "call", content: '{"error":"failed"}' })
  expect(
    chatInput(
      [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "string",
              toolName: "check",
              output: { type: "json", value: "literal" },
            },
          ],
        },
      ],
      config
    )[0]?.content
  ).toBe('"literal"')
  expect(
    chatInput(messages, { ...config, reasoningReplay: "omit" })[2]?.reasoning_content
  ).toBeUndefined()
  expect(
    chatInput(
      [...messages, { role: "user", content: [{ type: "text", text: "New turn" }] }],
      config
    )[2]?.reasoning_content
  ).toBeUndefined()
})
