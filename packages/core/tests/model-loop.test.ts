import { describe, expect, test } from "bun:test"
import { runModelLoop } from "../src/agents/model-loop"
import type {
  LanguageModelStreamEvent,
  ModelCallEndEvent,
  ModelTool,
  ModelUiChunk,
} from "../src/models"
import { ModelStreamError, StructuredOutputError } from "../src/models"
import { MockLanguageModel, streamFromArray } from "../src/models/testing"

const USAGE = {
  inputTokens: 10,
  outputTokens: 4,
  uncachedInputTokens: 8,
  cacheReadInputTokens: 2,
  raw: { prompt_tokens: 10, completion_tokens: 4 },
} as const

const MOCK_DEFINITION = {
  kind: "language",
  providerId: "mock",
  modelId: "mock-model",
  capabilities: {
    inputMediaTypes: ["image/*"],
    reasoning: true,
    localTools: true,
    parallelToolCalls: true,
    nativeStructuredOutput: true,
  },
} as const

function finish(finishReason: "stop" | "tool-calls" = "stop"): LanguageModelStreamEvent {
  return { type: "finish", finishReason, usage: USAGE }
}

function modelFromCalls(calls: readonly (readonly LanguageModelStreamEvent[])[]) {
  let index = 0
  return new MockLanguageModel({
    stream: async () => streamFromArray(calls[index++] ?? calls.at(-1) ?? []),
  })
}

const echo: ModelTool<{ value: string }> = {
  name: "echo",
  description: "Echo a value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  parseInput(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { value?: unknown }).value !== "string"
    ) {
      throw new TypeError("value must be a string")
    }
    return { value: (value as { value: string }).value }
  },
  async execute(input) {
    return { echoed: input.value }
  },
  errorText(error) {
    return error instanceof Error ? error.message : "Tool failed."
  },
}

describe("runModelLoop", () => {
  test("streams text and awaits completed-call accounting", async () => {
    const events: ModelUiChunk[] = []
    const calls: ModelCallEndEvent[] = []
    const result = await runModelLoop({
      model: modelFromCalls([
        [
          { type: "stream-start" },
          { type: "response-metadata", id: "response-1", modelId: "resolved-model" },
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: "Hello" },
          { type: "text-end", id: "answer" },
          finish(),
        ],
      ]),
      messages: [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      maxSteps: 4,
      signal: new AbortController().signal,
      onEvent(event) {
        events.push(event)
      },
      onModelCallEnd(event) {
        calls.push(event)
      },
      generateCallId: () => "call-1",
    })

    expect(result).toMatchObject({
      status: "completed",
      output: "Hello",
      finishReason: "stop",
    })
    expect(events).toEqual([
      { type: "start-step" },
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "Hello" },
      { type: "text-end", id: "answer" },
    ])
    expect(calls).toEqual([
      {
        callId: "call-1",
        providerId: "mock",
        modelId: "mock-model",
        responseId: "response-1",
        responseModelId: "resolved-model",
        usage: USAGE,
        definition: MOCK_DEFINITION,
        cost: { status: "unpriceable", reason: "missing-pricing" },
      },
    ])
  })

  test("records completed-call usage before rejecting invalid durable provider data", async () => {
    const calls: ModelCallEndEvent[] = []
    const invalidProviderData = { generatedAt: new Date() } as never

    await expect(
      runModelLoop({
        model: modelFromCalls([
          [
            { type: "stream-start" },
            { type: "text-start", id: "answer", providerData: invalidProviderData },
            { type: "text-delta", id: "answer", delta: "Hello" },
            { type: "text-end", id: "answer" },
            finish(),
          ],
        ]),
        messages: [],
        maxSteps: 1,
        signal: new AbortController().signal,
        onModelCallEnd(event) {
          calls.push(event)
        },
        generateCallId: () => "call-invalid-projection",
      })
    ).rejects.toThrow("provider data.generatedAt is a Date")
    expect(calls).toEqual([
      {
        callId: "call-invalid-projection",
        providerId: "mock",
        modelId: "mock-model",
        responseId: "call-invalid-projection:response",
        usage: USAGE,
        definition: MOCK_DEFINITION,
        cost: { status: "unpriceable", reason: "missing-pricing" },
      },
    ])
  })

  test("assembles fragmented tool JSON, executes tools, and replays results", async () => {
    const requests: unknown[] = []
    const model = new MockLanguageModel({
      stream: async (request) => {
        requests.push(request)
        return requests.length === 1
          ? streamFromArray([
              { type: "stream-start" },
              { type: "tool-input-start", id: "tool-1", toolName: "echo" },
              { type: "tool-input-delta", id: "tool-1", delta: '{"value"' },
              { type: "tool-input-delta", id: "tool-1", delta: ':"hi"}' },
              { type: "tool-input-end", id: "tool-1" },
              finish("tool-calls"),
            ])
          : streamFromArray([
              { type: "stream-start" },
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Echoed hi" },
              { type: "text-end", id: "answer" },
              finish(),
            ])
      },
    })

    const result = await runModelLoop({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "Echo hi" }] }],
      tools: [echo],
      maxSteps: 4,
      signal: new AbortController().signal,
    })

    expect(result.status).toBe("completed")
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]?.content).toContainEqual({
      type: "tool-result",
      toolCallId: "tool-1",
      toolName: "echo",
      output: { type: "json", value: { echoed: "hi" } },
    })
    expect(requests[1]).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "tool-1" }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "tool-1" }] },
      ],
    })
  })

  test("executes parallel tools but preserves model call order", async () => {
    const releases = new Map<string, () => void>()
    const completion: string[] = []
    const parallelTool: ModelTool<{ value: string }> = {
      ...echo,
      async execute(input) {
        await new Promise<void>((resolve) => releases.set(input.value, resolve))
        completion.push(input.value)
        return { echoed: input.value }
      },
    }
    const run = runModelLoop({
      model: modelFromCalls([
        [
          { type: "stream-start" },
          {
            type: "tool-call",
            toolCallId: "first",
            toolName: "echo",
            input: '{"value":"first"}',
          },
          {
            type: "tool-call",
            toolCallId: "second",
            toolName: "echo",
            input: '{"value":"second"}',
          },
          finish("tool-calls"),
        ],
        [
          { type: "stream-start" },
          { type: "text-start", id: "done" },
          { type: "text-delta", id: "done", delta: "done" },
          { type: "text-end", id: "done" },
          finish(),
        ],
      ]),
      messages: [{ role: "user", content: [{ type: "text", text: "Both" }] }],
      tools: [parallelTool],
      maxSteps: 3,
      signal: new AbortController().signal,
    })
    await Bun.sleep(0)
    releases.get("second")?.()
    releases.get("first")?.()
    const result = await run

    expect(completion).toEqual(["second", "first"])
    expect(result.steps[0]?.content.filter((part) => part.type === "tool-result")).toEqual([
      expect.objectContaining({ toolCallId: "first" }),
      expect.objectContaining({ toolCallId: "second" }),
    ])
  })

  test("returns coherent partial text when aborted mid-stream", async () => {
    const abort = new AbortController()
    const model = new MockLanguageModel({
      stream: async () => ({
        events: (async function* () {
          yield { type: "stream-start" } as const
          yield { type: "text-start", id: "answer" } as const
          yield { type: "text-delta", id: "answer", delta: "partial" } as const
          abort.abort()
          await Promise.resolve()
        })(),
      }),
    })
    const result = await runModelLoop({
      model,
      messages: [],
      maxSteps: 1,
      signal: abort.signal,
    })

    expect(result).toEqual({
      status: "aborted",
      steps: [],
      partialContent: [{ type: "text", text: "partial" }],
    })
  })

  test("accounts a finished response when cancellation races with stream teardown", async () => {
    const abort = new AbortController()
    const calls: ModelCallEndEvent[] = []
    const model = new MockLanguageModel({
      stream: async () => ({
        events: (async function* () {
          yield { type: "stream-start" } as const
          yield { type: "text-start", id: "answer" } as const
          yield { type: "text-delta", id: "answer", delta: "complete" } as const
          yield { type: "text-end", id: "answer" } as const
          yield finish()
          abort.abort()
          throw new DOMException("Aborted", "AbortError")
        })(),
      }),
    })

    const result = await runModelLoop({
      model,
      messages: [],
      maxSteps: 1,
      signal: abort.signal,
      onModelCallEnd(event) {
        calls.push(event)
      },
      generateCallId: () => "call-raced-abort",
    })

    expect(result).toEqual({
      status: "aborted",
      steps: [],
      partialContent: [{ type: "text", text: "complete" }],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.usage).toEqual(USAGE)
  })

  test("accounts a finished response before rejecting a post-finish protocol error", async () => {
    const calls: ModelCallEndEvent[] = []
    const model = new MockLanguageModel({
      stream: async () => ({
        events: (async function* () {
          yield { type: "stream-start" } as const
          yield finish()
          yield { type: "text-start", id: "too-late" } as const
        })(),
      }),
    })

    await expect(
      runModelLoop({
        model,
        messages: [],
        maxSteps: 1,
        signal: new AbortController().signal,
        onModelCallEnd(event) {
          calls.push(event)
        },
        generateCallId: () => "call-post-finish-error",
      })
    ).rejects.toThrow("after stream finish")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.usage).toEqual(USAGE)
  })

  test("validates structured text output and offers the reserved submission tool", async () => {
    let toolNames: readonly string[] = []
    const model = new MockLanguageModel({
      stream: async (request) => {
        toolNames = request.tools.map((tool) => tool.name)
        return streamFromArray([
          { type: "stream-start" },
          { type: "text-start", id: "json" },
          { type: "text-delta", id: "json", delta: '{"answer":"yes"}' },
          { type: "text-end", id: "json" },
          finish(),
        ])
      },
    })
    const result = await runModelLoop({
      model,
      messages: [],
      output: {
        name: "answer",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
        validate(value) {
          if (
            typeof value !== "object" ||
            value === null ||
            typeof (value as { answer?: unknown }).answer !== "string"
          ) {
            throw new TypeError("answer must be a string")
          }
          return value as { answer: string }
        },
      },
      maxSteps: 2,
      signal: new AbortController().signal,
    })

    expect(toolNames).toContain("__sixb_submit_output")
    expect(result).toMatchObject({ status: "completed", output: { answer: "yes" } })
  })

  test("rejects incomplete streams and invalid structured output", async () => {
    await expect(
      runModelLoop({
        model: modelFromCalls([[{ type: "stream-start" }]]),
        messages: [],
        maxSteps: 1,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(ModelStreamError)

    await expect(
      runModelLoop({
        model: modelFromCalls([
          [
            { type: "stream-start" },
            { type: "text-start", id: "bad" },
            { type: "text-delta", id: "bad", delta: "not-json" },
            { type: "text-end", id: "bad" },
            finish(),
          ],
        ]),
        messages: [],
        output: {
          name: "answer",
          schema: { type: "object" },
          validate: (value) => value,
        },
        maxSteps: 1,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(StructuredOutputError)
  })
})
