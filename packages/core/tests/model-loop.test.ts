import { describe, expect, test } from "bun:test"
import { runModelLoop } from "../src/agents/model-loop"
import type {
  LanguageModelStreamEvent,
  ModelAssistantPart,
  ModelCallEndEvent,
  ModelMessage,
  ModelTool,
  ModelUiChunk,
  ProviderData,
} from "../src/models"
import { ModelStreamError, rateModelCall, StructuredOutputError } from "../src/models"
import { MockLanguageModel, streamFromArray } from "./helpers/models"

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
    reasoning: {
      canDisable: true,
      efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      budgetTokens: {},
    },
    localTools: true,
    parallelToolCalls: true,
    nativeStructuredOutput: true,
  },
} as const

function finish(finishReason: "stop" | "tool-calls" | "pause" = "stop"): LanguageModelStreamEvent {
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
  test("normalizes metadata before completed steps, partial traces, and continuation requests", async () => {
    // Regression proof: return data unchanged in captureProviderData; undefined metadata then
    // either fails ingestion or survives the strict equality checks below.
    const metadata = {
      test: { signature: "signed", absent: undefined, nested: [{ absent: undefined }] },
    }
    const providerData = metadata as unknown as ProviderData
    const normalized = { test: { signature: "signed", nested: [{}] } }
    const events: LanguageModelStreamEvent[] = [
      { type: "stream-start" },
      { type: "reasoning-start", id: "reasoning", providerData },
      { type: "reasoning-delta", id: "reasoning", delta: "thinking" },
      {
        type: "reasoning-end",
        id: "reasoning",
        providerData: { end: { absent: undefined } } as unknown as ProviderData,
      },
      { type: "text-start", id: "text", providerData },
      { type: "text-delta", id: "text", delta: "answer" },
      { type: "text-end", id: "text" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search",
        input: "{}",
        providerExecuted: true,
        providerData,
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "search",
        output: "found",
        providerExecuted: true,
        providerData,
      },
    ]
    const expected: ModelAssistantPart[] = [
      { type: "reasoning", text: "thinking", providerData: { ...normalized, end: {} } },
      { type: "text", text: "answer", providerData: normalized },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "search",
        input: {},
        providerExecuted: true,
        providerData: normalized,
      },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "search",
        output: { type: "text", value: "found" },
        providerExecuted: true,
        providerData: normalized,
      },
    ]
    for (const interrupted of [false, true]) {
      const requests: ModelMessage[][] = []
      const abort = new AbortController()
      const model = new MockLanguageModel({
        stream: async (request) => {
          requests.push([...request.messages])
          return {
            events: (async function* () {
              if (requests.length > 1) {
                yield { type: "stream-start" } as const
                yield finish()
                return
              }
              yield* events
              if (interrupted) {
                abort.abort()
                throw new DOMException("Cancelled", "AbortError")
              }
              yield finish("pause")
            })(),
          }
        },
      })
      const result = await runModelLoop({ model, messages: [], maxSteps: 2, signal: abort.signal })
      if (interrupted) {
        expect(result.status).toBe("aborted")
        if (result.status !== "aborted") throw new Error("Expected interruption")
        expect(result.partialContent).toStrictEqual(expected)
      } else {
        expect(result.status).toBe("completed")
        expect(result.steps[0]?.content).toStrictEqual(expected)
        expect(requests[1]).toStrictEqual([{ role: "assistant", content: expected }])
      }
    }
    expect(Object.hasOwn(metadata.test, "absent")).toBe(true)
    expect(Object.hasOwn(metadata.test.nested[0]!, "absent")).toBe(true)
  })

  test("rejects malformed provider payloads after accounting and excludes them from partial traces", async () => {
    // Regression proof: remove assertJsonValue from captureJsonValue/normalizeProviderData;
    // malformed results or replay state then reach completed and partial model content.
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const invalid = [new Date("2026-09-08T00:00:00Z"), 1n, NaN, [undefined], cycle]
    const malformed: LanguageModelStreamEvent[] = [
      ...invalid.flatMap((value) => [
        { type: "provider-state", providerId: "test", data: value },
        { type: "tool-result", toolCallId: "call-1", toolName: "search", output: value },
        { type: "text-start", id: "text", providerData: { test: value } },
      ]),
      { type: "provider-state", providerId: "", data: {} },
      ...[null, [], "invalid", { [Symbol("invalid")]: true }].map((providerData) => ({
        type: "text-start",
        id: "text",
        providerData,
      })),
      { type: "provider-state", providerId: "test", data: { absent: undefined } },
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "search",
        output: { absent: undefined },
      },
    ] as unknown as LanguageModelStreamEvent[]
    for (const event of malformed) {
      for (const interrupted of [false, true]) {
        const calls: ModelCallEndEvent[] = []
        const abort = new AbortController()
        const model = new MockLanguageModel({
          stream: async () => ({
            events: (async function* () {
              yield { type: "stream-start" } as const
              yield event
              if (event.type === "text-start") yield { type: "text-end", id: "text" } as const
              if (interrupted) {
                abort.abort()
                throw new DOMException("Cancelled", "AbortError")
              }
              yield finish()
            })(),
          }),
        })
        const result = runModelLoop({
          model,
          messages: [],
          maxSteps: 1,
          signal: abort.signal,
          onModelCallEnd: (call) => {
            calls.push(call)
          },
        })
        if (interrupted) {
          const partial = await result
          expect(partial.status).toBe("aborted")
          if (partial.status !== "aborted") throw new Error("Expected interruption")
          expect(partial.partialContent).toEqual([])
        } else {
          await expect(result).rejects.toThrow()
          expect(calls[0]?.usage).toEqual(USAGE)
        }
        expect(calls).toHaveLength(1)
      }
    }
  })

  test("keeps non-JSON local tool outputs and projections out of model steps", async () => {
    // Regression proof: remove the tool-output or model-output JSON assertion in executeToolCall;
    // the invalid value then appears as a successful result instead of a recoverable tool error.
    for (const stage of ["execute", "projection"] as const) {
      const result = await runModelLoop({
        model: modelFromCalls([
          [
            { type: "stream-start" },
            { type: "tool-call", toolCallId: "call-1", toolName: "echo", input: '{"value":"ok"}' },
            finish("tool-calls"),
          ],
          [{ type: "stream-start" }, finish()],
        ]),
        tools: [
          {
            ...echo,
            execute: async () => (stage === "execute" ? { absent: undefined } : "valid") as never,
            toModelOutput: () =>
              (stage === "projection"
                ? { type: "json", value: { absent: undefined } }
                : { type: "text", value: "valid" }) as never,
            errorText: () => "Invalid tool output",
          },
        ],
        messages: [],
        maxSteps: 2,
        signal: new AbortController().signal,
      })
      expect(result.status).toBe("completed")
      expect(result.steps[0]?.content[1]).toStrictEqual({
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "echo",
        output: { type: "error-text", value: "Invalid tool output" },
      })
    }
  })

  // Regression proof: remove the finishReason guard before structured-output parsing.
  test.each([
    "length",
    "content-filter",
    "other",
    "unknown",
  ] as const)("rejects incomplete structured output even when JSON is valid (%s)", async (finishReason) => {
    const calls: ModelCallEndEvent[] = []
    let validations = 0
    await expect(
      runModelLoop({
        model: modelFromCalls([
          [
            { type: "stream-start" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: '{"answer":"yes"}' },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason, usage: USAGE },
          ],
        ]),
        messages: [],
        maxSteps: 1,
        signal: new AbortController().signal,
        output: {
          name: "answer",
          schema: { type: "object" },
          validate(value) {
            validations += 1
            return value
          },
        },
        onModelCallEnd(event) {
          calls.push(event)
        },
      })
    ).rejects.toBeInstanceOf(StructuredOutputError)
    expect(validations).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ usage: USAGE })
  })

  // Regression proof: put output publication back inside the tool-error catch.
  test("propagates output publication failure before another model call", async () => {
    const failure = new Error("stream sink unavailable")
    let calls = 0
    const chunks: ModelUiChunk[] = []
    const model = new MockLanguageModel({
      stream: async () => {
        calls += 1
        return streamFromArray([
          { type: "stream-start" },
          { type: "tool-call", toolCallId: "echo-1", toolName: "echo", input: '{"value":"ok"}' },
          finish("tool-calls"),
        ])
      },
    })
    await expect(
      runModelLoop({
        model,
        messages: [],
        tools: [echo],
        maxSteps: 2,
        signal: new AbortController().signal,
        onEvent(chunk) {
          chunks.push(chunk)
          if (chunk.type === "tool-output-available") throw failure
        },
      })
    ).rejects.toBe(failure)
    expect(calls).toBe(1)
    expect(chunks.some((chunk) => chunk.type === "tool-output-error")).toBe(false)
  })

  // Regression proof: publish success before toModelOutput; projection failure emits both outcomes.
  test("keeps tool and projection failures recoverable with exactly one outcome", async () => {
    for (const stage of ["execute", "projection"] as const) {
      const chunks: ModelUiChunk[] = []
      const failure = new Error(`${stage} failed`)
      const result = await runModelLoop({
        model: modelFromCalls([
          [
            { type: "stream-start" },
            { type: "tool-call", toolCallId: "echo-1", toolName: "echo", input: '{"value":"ok"}' },
            finish("tool-calls"),
          ],
          [{ type: "stream-start" }, finish()],
        ]),
        messages: [],
        tools: [
          {
            ...echo,
            async execute(input: { value: string }, context) {
              if (stage === "execute") throw failure
              return echo.execute(input, context)
            },
            toModelOutput() {
              throw failure
            },
          },
        ],
        maxSteps: 2,
        signal: new AbortController().signal,
        onEvent(chunk) {
          chunks.push(chunk)
        },
      })
      expect(result.status).toBe("completed")
      expect(chunks.filter((chunk) => chunk.type.startsWith("tool-output-"))).toEqual([
        {
          type: "tool-output-error",
          toolCallId: "echo-1",
          toolName: "echo",
          errorText: failure.message,
        },
      ])
    }
  })

  test("retains native IDs independently of the internal fallback response identity", async () => {
    // Removal proof: omit providerIds from CompletedResponse or onModelCallEnd.
    const calls: ModelCallEndEvent[] = []
    for (const providerIds of [undefined, { generationId: "gen_1", requestId: "req_1" }]) {
      await runModelLoop({
        model: modelFromCalls([
          [
            { type: "stream-start" },
            { type: "response-metadata", ...(providerIds ? { providerIds } : {}) },
            finish(),
          ],
        ]),
        messages: [],
        maxSteps: 1,
        signal: new AbortController().signal,
        onModelCallEnd: async (event) => {
          calls.push(event)
        },
      })
    }
    expect(calls[0]?.responseId).toContain(":response")
    expect(calls[0]?.providerIds).toBeUndefined()
    expect(calls[1]?.providerIds).toEqual({ generationId: "gen_1", requestId: "req_1" })
  })
  test("retains a provider-owned estimate alongside an inline report", async () => {
    // Regression proof: omit estimate from onModelCallEnd; this must fail even though cost is reported.
    const calls: ModelCallEndEvent[] = []
    const model = Object.assign(
      modelFromCalls([
        [
          { type: "stream-start" },
          {
            type: "finish",
            finishReason: "stop",
            usage: USAGE,
            reportedCost: { money: { currency: "USD", amountNanos: "12" } },
          },
        ],
      ]),
      {
        costEstimator: {
          estimate: ({ usage }: { usage: typeof USAGE }) =>
            rateModelCall({
              usage,
              rateCard: {
                currency: "USD",
                unit: "million-tokens",
                input: "1",
                output: "2",
                cacheReadInput: "0.1",
              },
            }),
        },
      }
    )
    await runModelLoop({
      model,
      messages: [],
      maxSteps: 1,
      signal: new AbortController().signal,
      onModelCallEnd: (event) => {
        calls.push(event)
      },
    })
    expect(calls[0]).toMatchObject({
      cost: { status: "reported", money: { amountNanos: "12" } },
      estimate: { status: "rated", money: { amountNanos: "16200" } },
    })
  })

  test("estimation failure cannot discard completed usage or an inline report", async () => {
    // Regression proof: call costEstimator.estimate directly without the failure boundary.
    const calls: ModelCallEndEvent[] = []
    const model = Object.assign(
      modelFromCalls([
        [
          { type: "stream-start" },
          {
            type: "finish",
            finishReason: "stop",
            usage: USAGE,
            reportedCost: { money: { currency: "USD", amountNanos: "12" } },
          },
        ],
      ]),
      {
        costEstimator: {
          estimate: () => {
            throw new Error("unavailable estimator")
          },
        },
      }
    )
    await runModelLoop({
      model,
      messages: [],
      maxSteps: 1,
      signal: new AbortController().signal,
      onModelCallEnd: (event) => {
        calls.push(event)
      },
    })
    expect(calls[0]).toMatchObject({
      usage: USAGE,
      cost: { status: "reported" },
      estimate: { status: "unpriceable" },
    })
  })
  test("forwards and validates per-call output limits", async () => {
    // Regression proof: remove maxOutputTokens from the model.stream request or its validation.
    const model = new MockLanguageModel({
      stream: async (request) => {
        expect(request.maxOutputTokens).toBe(512)
        expect(request.caching).toBe("off")
        return streamFromArray([{ type: "stream-start" }, finish()])
      },
    })
    const input = { model, messages: [], maxSteps: 1, signal: new AbortController().signal }
    await runModelLoop({ ...input, maxOutputTokens: 512, caching: "off" })
    for (const maxOutputTokens of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(runModelLoop({ ...input, maxOutputTokens })).rejects.toThrow(
        "positive safe integer"
      )
    }
  })
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
      reasoning: "high",
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
        cost: { status: "unpriceable", reason: "missing-rate-card" },
        requestedReasoning: "high",
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
        cost: { status: "unpriceable", reason: "missing-rate-card" },
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

  // Regression proof: append continuations to the original messages instead of requestMessages.
  test.each([
    "tool-calls",
    "pause",
  ] as const)("retains prepared images across %s continuations", async (continuation) => {
    const requests: ModelMessage[][] = []
    const image: ModelMessage = {
      role: "user",
      content: [
        { type: "file", data: new URL("data:image/png;base64,aW1hZ2U="), mediaType: "image/png" },
      ],
    }
    const model = new MockLanguageModel({
      stream: async (request) => {
        const stepIndex = requests.length
        requests.push([...request.messages])
        return streamFromArray([
          { type: "stream-start" },
          ...(stepIndex === 0 || (stepIndex === 1 && continuation === "tool-calls")
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: `echo-${stepIndex}`,
                  toolName: "echo",
                  input: '{"value":"ok"}',
                },
              ]
            : []),
          finish(stepIndex === 0 ? "tool-calls" : stepIndex === 1 ? continuation : "stop"),
        ])
      },
    })
    const result = await runModelLoop({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "Inspect this file." }] }],
      tools: [echo],
      maxSteps: 3,
      signal: new AbortController().signal,
      prepareStep: ({ stepIndex, messages }) =>
        stepIndex === 1 ? { messages: [...messages, image] } : undefined,
    })

    expect(result.status).toBe("completed")
    expect(requests).toHaveLength(3)
    expect(requests[1]?.at(-1)).toEqual(image)
    expect(requests[2]?.slice(0, requests[1]?.length)).toEqual(requests[1])
    expect(requests[2]?.filter((message) => message === image)).toHaveLength(1)
  })

  // Regression proof: move prepareStep outside the abort boundary, or omit its post-await check.
  test.each([
    "throw",
    "return",
  ] as const)("retains completed steps when aborted during preparation (%s)", async (outcome) => {
    const abort = new AbortController()
    const calls: ModelCallEndEvent[] = []
    let requests = 0
    const model = new MockLanguageModel({
      stream: async () => {
        requests += 1
        return streamFromArray([
          { type: "stream-start" },
          { type: "tool-call", toolCallId: "echo-1", toolName: "echo", input: '{"value":"ok"}' },
          finish("tool-calls"),
        ])
      },
    })
    const result = await runModelLoop({
      model,
      messages: [],
      tools: [echo],
      maxSteps: 3,
      signal: abort.signal,
      prepareStep: async ({ stepIndex, signal }): Promise<undefined> => {
        if (stepIndex !== 1) return
        abort.abort(new Error("cancelled during projection"))
        if (outcome === "throw") signal.throwIfAborted()
      },
      onModelCallEnd: (event) => {
        calls.push(event)
      },
    })

    expect(result).toMatchObject({ status: "aborted", partialContent: [] })
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.content).toContainEqual({
      type: "tool-result",
      toolCallId: "echo-1",
      toolName: "echo",
      output: { type: "json", value: { echoed: "ok" } },
    })
    expect(requests).toBe(1)
    expect(calls).toHaveLength(1)
  })

  test("propagates preparation errors without starting a model call", async () => {
    const failure = new Error("projection unavailable")
    let calls = 0
    await expect(
      runModelLoop({
        model: new MockLanguageModel({
          stream: async () => {
            calls += 1
            return streamFromArray([{ type: "stream-start" }, finish()])
          },
        }),
        messages: [],
        maxSteps: 1,
        signal: new AbortController().signal,
        prepareStep: () => {
          throw failure
        },
      })
    ).rejects.toBe(failure)
    expect(calls).toBe(0)
  })

  test("continues a provider pause without inventing a local tool result", async () => {
    const requests: unknown[] = []
    const model = new MockLanguageModel({
      stream: async (request) => {
        requests.push(request)
        return requests.length === 1
          ? streamFromArray([
              { type: "stream-start" },
              { type: "text-start", id: "partial" },
              { type: "text-delta", id: "partial", delta: "Working" },
              { type: "text-end", id: "partial" },
              finish("pause"),
            ])
          : streamFromArray([
              { type: "stream-start" },
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Done" },
              { type: "text-end", id: "answer" },
              finish(),
            ])
      },
    })

    const result = await runModelLoop({
      model,
      messages: [{ role: "user", content: [{ type: "text", text: "Start" }] }],
      maxSteps: 2,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ status: "completed", output: "Done", finishReason: "stop" })
    expect(result.steps).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      messages: [
        { role: "user" },
        { role: "assistant", content: [{ type: "text", text: "Working" }] },
      ],
    })
  })

  test("records a final-step tool response without starting an unbounded continuation", async () => {
    let offeredTools: readonly string[] = []
    const model = new MockLanguageModel({
      stream: async (request) => {
        offeredTools = request.tools.map((tool) => tool.name)
        return streamFromArray([
          { type: "stream-start" },
          {
            type: "tool-call",
            toolCallId: "too-late",
            toolName: "echo",
            input: '{"value":"late"}',
          },
          finish("tool-calls"),
        ])
      },
    })

    const result = await runModelLoop({
      model,
      messages: [],
      tools: [echo],
      maxSteps: 1,
      finalStepInstruction: "Answer now without using tools.",
      signal: new AbortController().signal,
    })

    expect(offeredTools).toEqual([])
    expect(result).toMatchObject({
      status: "completed",
      output: "",
      finishReason: "tool-calls",
    })
    expect(result.steps[0]?.content).toContainEqual(
      expect.objectContaining({ type: "tool-call", toolCallId: "too-late" })
    )
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

  test("accounts accepted interrupted streams as unknown instead of free", async () => {
    // Removal proof: record only after accumulator.complete(); none of these calls are preserved.
    for (const end of ["abort", "error", "eof"] as const) {
      const abort = new AbortController()
      const calls: ModelCallEndEvent[] = []
      const model = new MockLanguageModel({
        stream: async () => ({
          events: (async function* () {
            yield { type: "stream-start" } as const
            yield {
              type: "response-metadata",
              providerIds: { requestId: "req-partial" },
              modelId: "served",
            } as const
            if (end === "abort") abort.abort()
            if (end === "error") throw new Error("connection lost")
          })(),
        }),
      })
      const result = runModelLoop({
        model,
        messages: [],
        maxSteps: 1,
        signal: abort.signal,
        onModelCallEnd: async (event) => {
          calls.push(event)
        },
      })
      if (end === "abort") expect((await result).status).toBe("aborted")
      else
        await expect(result).rejects.toThrow(end === "error" ? "connection lost" : "finish event")
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({
        providerIds: { requestId: "req-partial" },
        responseModelId: "served",
        usage: {},
        cost: { status: "unpriceable", reason: "missing-usage" },
      })
    }
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

  test("always sends the semantic response format and validates the completed output", async () => {
    let toolNames: readonly string[] = []
    let responseFormat: unknown
    const model = new MockLanguageModel({
      capabilities: { ...MOCK_DEFINITION.capabilities, nativeStructuredOutput: false },
      stream: async (request) => {
        toolNames = request.tools.map((tool) => tool.name)
        responseFormat = request.responseFormat
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

    expect(toolNames).toEqual([])
    expect(responseFormat).toEqual({
      type: "json",
      name: "answer",
      schema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    })
    expect(result).toMatchObject({ status: "completed", output: { answer: "yes" } })
  })

  test("does not let model metadata change the provider-neutral output request", async () => {
    let toolNames: readonly string[] = []
    let responseFormat: unknown
    const model = new MockLanguageModel({
      stream: async (request) => {
        toolNames = request.tools.map((tool) => tool.name)
        responseFormat = request.responseFormat
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
        schema: { type: "object", properties: { answer: { type: "string" } } },
        validate: (value) => value as { answer: string },
      },
      maxSteps: 1,
      signal: new AbortController().signal,
    })

    expect(toolNames).not.toContain("__sixb_submit_output")
    expect(responseFormat).toEqual({
      type: "json",
      name: "answer",
      schema: { type: "object", properties: { answer: { type: "string" } } },
    })
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

    let structuredError: unknown
    try {
      await runModelLoop({
        model: modelFromCalls([
          [
            { type: "stream-start" },
            { type: "response-metadata", id: "response-bad", modelId: "resolved-bad" },
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
        generateCallId: () => "call-bad",
      })
    } catch (error) {
      structuredError = error
    }
    expect(structuredError).toBeInstanceOf(StructuredOutputError)
    expect(structuredError).toMatchObject({
      text: "not-json",
      providerId: "mock",
      modelId: "mock-model",
      responseId: "response-bad",
      responseModelId: "resolved-bad",
      finishReason: "stop",
      usage: USAGE,
    })
  })

  test("rejects a model whose synchronous definition has a different identity", async () => {
    await expect(
      runModelLoop({
        model: {
          providerId: "mock",
          modelId: "requested",
          definition: {
            kind: "language",
            providerId: "mock",
            modelId: "different",
            capabilities: {},
          },
          stream: async () => streamFromArray([]),
        },
        messages: [],
        maxSteps: 1,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow("different identity")
  })
})
