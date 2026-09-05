import { describe, expect, test } from "bun:test"
import { runModelLoop } from "@sixb/core/internal/agents"
import type { LanguageModelRequest, LanguageModelStreamEvent, ModelOutput } from "@sixb/core/models"
import { ModelProviderError } from "@sixb/core/models"
import { anthropic, createAnthropic } from "../src"
import { decodeServerSentEvents } from "../src/sse"
import { anthropicOutputSchema } from "../src/structured-output"

function request(overrides: Partial<LanguageModelRequest> = {}): LanguageModelRequest {
  return {
    callId: "call-1",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

function sseResponse(events: readonly unknown[], chunkSize = 17): Response {
  const encoded = new TextEncoder().encode(
    events
      .map(
        (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join("")
  )
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < encoded.length; offset += chunkSize) {
          controller.enqueue(encoded.slice(offset, offset + chunkSize))
        }
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  )
}

async function collect(stream: AsyncIterable<LanguageModelStreamEvent>) {
  const events: LanguageModelStreamEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe("Anthropic provider", () => {
  test("resolves model input limits through the shared catalog without mutating the binding", async () => {
    // Regression proof: remove resolveDefinition or expire the pending loadPromise before loadedAt is set.
    let calls = 0
    const provider = createAnthropic({
      apiKey: "test",
      fetch: async (_url, init) => {
        calls += 1
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return Response.json({
          data: [
            {
              id: "claude-sonnet-4-5",
              type: "model",
              max_input_tokens: 200_000,
              max_tokens: 64_000,
              capabilities: {},
            },
          ],
          has_more: false,
        })
      },
    })
    const model = provider("claude-sonnet-4-5", { capabilities: { localTools: false } })
    const original = model.definition
    expect(calls).toBe(0)
    const [resolved, other] = await Promise.all([
      model.resolveDefinition?.(),
      provider("claude-sonnet-4-5").resolveDefinition?.(),
    ])
    expect(calls).toBe(1)
    expect(resolved).toMatchObject({ maxInputTokens: 200_000, capabilities: { localTools: false } })
    expect(resolved?.contextWindow).toBeUndefined()
    expect(other?.maxInputTokens).toBe(200_000)
    expect(model.definition).toBe(original)
    expect(model.definition.maxInputTokens).toBeUndefined()
    await model.resolveDefinition?.()
    expect(calls).toBe(1)
  })

  test("resolves supplied definitions offline and preserves binding pricing modifiers", async () => {
    const provider = createAnthropic({
      models: [
        {
          kind: "language",
          providerId: "anthropic",
          modelId: "claude-sonnet-4-5",
          maxInputTokens: 123_000,
          capabilities: {},
          rateCard: { currency: "USD", unit: "million-tokens", input: "3", output: "15" },
        },
      ],
      fetch: async () => {
        throw new Error("must not fetch")
      },
    })
    const model = provider("claude-sonnet-4-5", {
      providerTools: [{ type: "web_search_20250305", name: "web_search" }],
    })
    const definition = await model.resolveDefinition?.()
    expect(definition?.maxInputTokens).toBe(123_000)
    expect(definition?.rateCard).toBeUndefined()
  })

  test("reports catalog failures, retries later, and does not invent unknown model limits", async () => {
    let calls = 0
    const provider = createAnthropic({
      apiKey: "test",
      fetch: async () => {
        if (++calls === 1) throw new Error("catalog unavailable")
        return Response.json({ data: [], has_more: false })
      },
    })
    const model = provider("custom-model", { maxOutputTokens: 512 })
    await expect(model.resolveDefinition?.()).rejects.toThrow("catalog unavailable")
    expect(await model.resolveDefinition?.()).toBe(model.definition)
    expect(model.definition.maxInputTokens).toBeUndefined()
    expect(calls).toBe(2)
  })
  test("honors per-call summary limits without raising the model ceiling", async () => {
    // Regression proof: use this.maxOutputTokens unconditionally in prepareRequest.
    const bodies: Record<string, unknown>[] = []
    const provider = createAnthropic({
      apiKey: "test",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return sseResponse([])
      },
    })
    const model = provider("claude-sonnet-4-5", { maxOutputTokens: 2_048 })
    await model.stream(request({ maxOutputTokens: 512, reasoning: "none" }))
    await model.stream(request({ maxOutputTokens: 4_096 }))
    expect(bodies.map((body) => body.max_tokens)).toEqual([512, 2_048])
    await expect(model.stream(request({ maxOutputTokens: 0 }))).rejects.toThrow(
      "positive safe integer"
    )
    expect(bodies).toHaveLength(2)
  })
  test("does not narrow open object schemas for the native decoder", () => {
    expect(
      anthropicOutputSchema({
        type: "object",
        properties: { answer: { type: "string" } },
      })
    ).toBeUndefined()
    expect(
      anthropicOutputSchema({
        type: "object",
        additionalProperties: { type: "string" },
      })
    ).toBeUndefined()
  })

  test("maps Messages API requests and normalizes text, thinking, and usage", async () => {
    let capturedUrl = ""
    let capturedHeaders: Headers | undefined
    let capturedBody: Record<string, unknown> | undefined
    const provider = createAnthropic({
      baseUrl: "https://anthropic.example/v1/",
      apiKey: () => "secret-key",
      apiVersion: "2023-06-01",
      betas: ["one-beta", "two-beta"],
      headers: { "x-project": "sixb" },
      fetch: async (input, init) => {
        capturedUrl = String(input)
        capturedHeaders = new Headers(init?.headers)
        capturedBody = JSON.parse(String(init?.body))
        return sseResponse([
          {
            type: "message_start",
            message: {
              id: "msg-1",
              model: "claude-opus-5-20260724",
              usage: {
                input_tokens: 12,
                cache_creation_input_tokens: 4,
                cache_read_input_tokens: 3,
                output_tokens: 1,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Think" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "signed" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Hello" },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: {
              output_tokens: 7,
              output_tokens_details: { thinking_tokens: 2 },
            },
          },
          { type: "message_stop" },
        ])
      },
    })
    const model = provider("claude-opus-5", {
      maxOutputTokens: 8_192,
      request: { temperature: 0.2, cache_control: { type: "ephemeral" } },
      providerTools: [{ type: "web_search_20260209", name: "web_search" }],
      capabilities: { nativeStructuredOutput: true },
    })
    const result = await model.stream(
      request({
        reasoning: "medium",
        messages: [
          { role: "system", content: "Be useful." },
          {
            role: "user",
            content: [
              { type: "text", text: "Read this." },
              {
                type: "file",
                data: new URL("data:image/png;base64,aGVsbG8="),
                mediaType: "image/png",
              },
            ],
          },
        ],
        tools: [
          {
            name: "echo",
            description: "Echo input.",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
          },
        ],
        responseFormat: {
          type: "json",
          name: "answer",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      })
    )
    const events = await collect(result.events)

    expect(capturedUrl).toBe("https://anthropic.example/v1/messages")
    expect(capturedHeaders?.get("x-api-key")).toBe("secret-key")
    expect(capturedHeaders?.get("anthropic-version")).toBe("2023-06-01")
    expect(capturedHeaders?.get("anthropic-beta")).toBe("one-beta,two-beta")
    expect(capturedHeaders?.get("x-project")).toBe("sixb")
    expect(capturedBody).toMatchObject({
      model: "claude-opus-5",
      max_tokens: 8192,
      stream: true,
      temperature: 0.2,
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: "Be useful." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read this." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
        },
      ],
      tools: [
        { type: "web_search_20260209", name: "web_search" },
        { name: "echo", strict: true },
      ],
      tool_choice: { type: "auto" },
      output_config: {
        effort: "medium",
        format: {
          type: "json_schema",
          schema: { type: "object", properties: { answer: { type: "string" } } },
        },
      },
    })
    expect(events).toEqual([
      { type: "stream-start" },
      { type: "response-metadata", id: "msg-1", modelId: "claude-opus-5-20260724" },
      { type: "reasoning-start", id: "content:0" },
      { type: "reasoning-delta", id: "content:0", delta: "Think" },
      {
        type: "reasoning-end",
        id: "content:0",
        providerData: {
          anthropic: {
            block: { type: "thinking", thinking: "Think", signature: "signed" },
          },
        },
      },
      { type: "text-start", id: "content:1" },
      { type: "text-delta", id: "content:1", delta: "Hello" },
      {
        type: "text-end",
        id: "content:1",
        providerData: { anthropic: { block: { type: "text", text: "Hello" } } },
      },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "end_turn",
        usage: {
          inputTokens: 19,
          outputTokens: 7,
          uncachedInputTokens: 12,
          cacheReadInputTokens: 3,
          cacheWriteInputTokens: 4,
          textOutputTokens: 5,
          reasoningOutputTokens: 2,
          raw: {
            input_tokens: 12,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 3,
            output_tokens: 7,
            output_tokens_details: { thinking_tokens: 2 },
          },
        },
      },
    ])
  })

  test("resolves native structured output through the callable provider path", async () => {
    const requested: string[] = []
    let messageBody: Record<string, unknown> | undefined
    const provider = createAnthropic({
      baseUrl: "https://anthropic.example/v1",
      apiKey: "secret-key",
      fetch: async (input, init) => {
        const url = String(input)
        requested.push(url)
        if (url.includes("/models")) {
          return Response.json({
            data: [
              {
                id: "claude-sonnet-5",
                type: "model",
                max_tokens: 128_000,
                capabilities: { structured_outputs: { supported: true } },
              },
            ],
            has_more: false,
          })
        }
        messageBody = JSON.parse(String(init?.body))
        return sseResponse([
          {
            type: "message_start",
            message: {
              id: "msg-structured-native",
              model: "claude-sonnet-5",
              usage: { input_tokens: 8, output_tokens: 1 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: '{"answer":"yes"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ])
      },
    })

    const result = await runModelLoop({
      model: provider("claude-sonnet-5"),
      messages: [{ role: "user", content: [{ type: "text", text: "Answer yes." }] }],
      output: answerOutput(),
      maxSteps: 1,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ status: "completed", output: { answer: "yes" } })
    expect(requested).toEqual([
      "https://anthropic.example/v1/models?limit=1000",
      "https://anthropic.example/v1/messages",
    ])
    expect(messageBody).toMatchObject({
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              answer: { type: "string", description: "pattern: ^yes$." },
            },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    })
    expect(messageBody?.tools).toBeUndefined()
  })

  test("hides a required nonparallel JSON tool when native output is unavailable", async () => {
    let messageBody: Record<string, unknown> | undefined
    const provider = createAnthropic({
      baseUrl: "https://anthropic.example/v1",
      apiKey: "secret-key",
      fetch: async (_input, init) => {
        messageBody = JSON.parse(String(init?.body))
        return sseResponse([
          {
            type: "message_start",
            message: {
              id: "msg-structured-tool",
              model: "claude-legacy",
              usage: { input_tokens: 8, output_tokens: 1 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu-output",
              name: "sixb_structured_output",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"answer":"yes"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ])
      },
    })

    const result = await runModelLoop({
      model: provider("claude-legacy", {
        maxOutputTokens: 4_096,
        capabilities: { nativeStructuredOutput: false },
      }),
      messages: [{ role: "user", content: [{ type: "text", text: "Answer yes." }] }],
      output: answerOutput(),
      maxSteps: 1,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({
      status: "completed",
      output: { answer: "yes" },
      finishReason: "stop",
      steps: [{ content: [{ type: "text", text: '{"answer":"yes"}' }] }],
    })
    expect(messageBody).toMatchObject({
      tool_choice: { type: "any" },
      disable_parallel_tool_use: true,
      tools: [
        {
          name: "sixb_structured_output",
          input_schema: answerOutput().schema,
        },
      ],
    })
    expect(messageBody?.output_config).toBeUndefined()
  })

  test("uses provider-owned model output limits when no request ceiling is configured", async () => {
    const bodies: Record<string, unknown>[] = []
    const transport = {
      fetch: async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return sseResponse([])
      },
    }
    const provider = createAnthropic(transport)
    const expected = [
      ["claude-sonnet-5", 128_000],
      ["claude-sonnet-4-6", 128_000],
      ["claude-haiku-4-5-20251001", 64_000],
      ["claude-opus-4-1-20250805", 32_000],
      ["claude-3-haiku-20240307", 4_096],
      ["claude-future-6", 128_000],
    ] as const

    for (const [modelId, maxOutputTokens] of expected) {
      const model = provider(modelId)
      expect(model.definition.maxOutputTokens).toBe(maxOutputTokens)
      await model.stream(request())
    }
    expect(bodies.map((body) => body.max_tokens)).toEqual(expected.map((entry) => entry[1]))

    expect(() => provider("custom-compatible-model")).toThrow(
      "maxOutputTokens is required for unknown model 'custom-compatible-model'"
    )
    const explicit = provider("custom-compatible-model", { maxOutputTokens: 12_000 })
    expect(explicit.definition.maxOutputTokens).toBeUndefined()
    await explicit.stream(request())
    expect(bodies.at(-1)?.max_tokens).toBe(12_000)

    const configured = createAnthropic({
      ...transport,
      models: [
        {
          kind: "language",
          providerId: "anthropic",
          modelId: "custom-compatible-model",
          maxOutputTokens: 24_000,
          capabilities: {},
        },
      ],
    })("custom-compatible-model")
    expect(configured.definition.maxOutputTokens).toBe(24_000)
    await configured.stream(request())
    expect(bodies.at(-1)?.max_tokens).toBe(24_000)
  })

  test("maps exact reasoning budgets and rejects unsupported effort without approximation", async () => {
    let capturedBody: Record<string, unknown> | undefined
    let requests = 0
    const provider = createAnthropic({
      apiKey: "secret-key",
      fetch: async (_input, init) => {
        requests += 1
        capturedBody = JSON.parse(String(init?.body))
        return sseResponse([])
      },
    })
    await provider("claude-sonnet-4", { maxOutputTokens: 8_192 }).stream(
      request({ reasoning: { budgetTokens: 4_096 } })
    )

    expect(capturedBody).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 4_096 },
    })
    await expect(
      provider("claude-sonnet-4").stream(request({ reasoning: "minimal" }))
    ).rejects.toThrow("does not support reasoning effort 'minimal'")
    expect(requests).toBe(1)
  })

  test("streams tool JSON and replays signed provider blocks exactly", async () => {
    let capturedBody: Record<string, unknown> | undefined
    let call = 0
    const provider = createAnthropic({
      baseUrl: "https://anthropic.example/v1",
      fetch: async (_input, init) => {
        call += 1
        capturedBody = JSON.parse(String(init?.body))
        return call === 1
          ? sseResponse([
              {
                type: "message_start",
                message: { id: "msg-tool", model: "claude-sonnet-5", usage: {} },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "tool_use", id: "toolu-1", name: "weather", input: {} },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '{"city":' },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "input_json_delta", partial_json: '"Boston"}' },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "content_block_start",
                index: 1,
                content_block: { type: "redacted_thinking", data: "opaque" },
              },
              { type: "content_block_stop", index: 1 },
              {
                type: "content_block_start",
                index: 2,
                content_block: {
                  type: "server_tool_use",
                  id: "srvtoolu-1",
                  name: "web_search",
                  input: {},
                },
              },
              {
                type: "content_block_delta",
                index: 2,
                delta: { type: "input_json_delta", partial_json: '{"query":"weather"}' },
              },
              { type: "content_block_stop", index: 2 },
              {
                type: "content_block_start",
                index: 3,
                content_block: {
                  type: "web_search_tool_result",
                  tool_use_id: "srvtoolu-1",
                  content: [{ type: "web_search_result", title: "Forecast" }],
                },
              },
              { type: "content_block_stop", index: 3 },
              {
                type: "message_delta",
                delta: { stop_reason: "tool_use" },
                usage: { output_tokens: 20 },
              },
              { type: "message_stop" },
            ])
          : sseResponse([
              {
                type: "message_start",
                message: { id: "msg-next", model: "claude-sonnet-5", usage: {} },
              },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ])
      },
    })
    const model = provider("claude-sonnet-5")
    const first = await model.stream(request())
    const events = await collect(first.events)

    expect(events).toContainEqual({
      type: "tool-input-end",
      id: "toolu-1",
      providerData: {
        anthropic: {
          block: {
            type: "tool_use",
            id: "toolu-1",
            name: "weather",
            input: { city: "Boston" },
          },
        },
      },
    })
    expect(events).toContainEqual({
      type: "provider-state",
      providerId: "anthropic",
      data: { block: { type: "redacted_thinking", data: "opaque" } },
    })
    expect(events).toContainEqual({
      type: "provider-state",
      providerId: "anthropic",
      data: {
        block: {
          type: "server_tool_use",
          id: "srvtoolu-1",
          name: "web_search",
          input: { query: "weather" },
        },
      },
    })

    const second = await model.stream(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "toolu-1",
                toolName: "weather",
                input: { city: "Boston" },
                providerData: {
                  anthropic: {
                    block: {
                      type: "tool_use",
                      id: "toolu-1",
                      name: "weather",
                      input: { city: "Boston" },
                    },
                  },
                },
              },
              {
                type: "provider-state",
                providerId: "anthropic",
                data: { block: { type: "redacted_thinking", data: "opaque" } },
              },
              {
                type: "provider-state",
                providerId: "anthropic",
                data: {
                  block: {
                    type: "server_tool_use",
                    id: "srvtoolu-1",
                    name: "web_search",
                    input: { query: "weather" },
                  },
                },
              },
              {
                type: "provider-state",
                providerId: "anthropic",
                data: {
                  block: {
                    type: "web_search_tool_result",
                    tool_use_id: "srvtoolu-1",
                    content: [{ type: "web_search_result", title: "Forecast" }],
                  },
                },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "toolu-1",
                toolName: "weather",
                output: { type: "json", value: { temperature: 70 } },
              },
            ],
          },
        ],
      })
    )
    await collect(second.events)

    expect(capturedBody?.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu-1", name: "weather", input: { city: "Boston" } },
          { type: "redacted_thinking", data: "opaque" },
          {
            type: "server_tool_use",
            id: "srvtoolu-1",
            name: "web_search",
            input: { query: "weather" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu-1",
            content: [{ type: "web_search_result", title: "Forecast" }],
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu-1",
            content: '{"temperature":70}',
          },
        ],
      },
    ])
  })

  test("loads paged model metadata, capabilities, and family rate cards", async () => {
    const requested: string[] = []
    const provider = createAnthropic({
      apiKey: "catalog-key",
      fetch: async (input, init) => {
        const url = String(input)
        requested.push(url)
        expect(new Headers(init?.headers).get("x-api-key")).toBe("catalog-key")
        if (!url.includes("after_id=")) {
          return Response.json({
            data: [
              {
                id: "claude-opus-5",
                type: "model",
                display_name: "Claude Opus 5",
                created_at: "2026-07-24T00:00:00Z",
                max_input_tokens: 1_000_000,
                max_tokens: 128_000,
                capabilities: {
                  image_input: { supported: true },
                  pdf_input: { supported: true },
                  thinking: {
                    supported: true,
                    types: {
                      adaptive: { supported: true },
                      enabled: { supported: false },
                    },
                  },
                  effort: {
                    low: { supported: true },
                    medium: { supported: true },
                    high: { supported: true },
                    xhigh: { supported: true },
                    max: { supported: true },
                  },
                  structured_outputs: { supported: true },
                  code_execution: { supported: true },
                },
              },
            ],
            has_more: true,
            last_id: "claude-opus-5",
          })
        }
        return Response.json({
          data: [
            {
              id: "claude-sonnet-5",
              type: "model",
              display_name: "Claude Sonnet 5",
              created_at: "2026-07-24T00:00:00Z",
              capabilities: {},
            },
          ],
          has_more: false,
          last_id: "claude-sonnet-5",
        })
      },
    })

    const definitions = await provider.catalog.list()
    expect(requested).toHaveLength(2)
    expect(requested[1]).toContain("after_id=claude-opus-5")
    expect(definitions[0]).toMatchObject({
      modelId: "claude-opus-5",
      name: "Claude Opus 5",
      releaseDate: "2026-07-24",
      maxInputTokens: 1_000_000,
      maxOutputTokens: 128_000,
      capabilities: {
        inputMediaTypes: ["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"],
        reasoning: {
          canDisable: true,
          efforts: ["low", "medium", "high", "xhigh", "max"],
        },
        localTools: true,
        parallelToolCalls: true,
        nativeStructuredOutput: true,
        providerExecutedTools: true,
      },
      rateCard: {
        input: "5",
        output: "25",
        cacheReadInput: "0.5",
        cacheWriteInput5m: "6.25",
        cacheWriteInput1h: "10",
      },
    })
    expect(definitions[1]?.capabilities.reasoning).toBe(false)
    expect(definitions[1]?.rateCard).toMatchObject({ input: "2", output: "10" })
  })

  test("builds request-specific rate cards without loading the catalog", () => {
    let requests = 0
    const provider = createAnthropic({
      fetch: async () => {
        requests += 1
        throw new Error("catalog unavailable")
      },
    })
    const model = provider("claude-opus-5", {
      request: {
        speed: "fast",
        inference_geo: "us",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    })

    expect(model.definition).toMatchObject({
      rateCard: {
        input: "11",
        output: "55",
        cacheReadInput: "1.1",
        cacheWriteInput5m: "13.75",
        cacheWriteInput1h: "22",
      },
    })
    const serverToolModel = provider("claude-opus-5", {
      providerTools: [{ type: "web_search_20260209", name: "web_search" }],
    })
    expect(serverToolModel.definition.rateCard).toBeUndefined()
    expect(requests).toBe(0)
  })

  test("retries retryable pre-stream responses and preserves pause_turn", async () => {
    let attempts = 0
    const provider = createAnthropic({
      maxRetries: 1,
      fetch: async () => {
        attempts += 1
        if (attempts === 1) {
          return Response.json(
            { error: { type: "overloaded_error", message: "try again" } },
            {
              status: 529,
              headers: { "request-id": "req-retry", "retry-after-ms": "0" },
            }
          )
        }
        return sseResponse([
          {
            type: "message_start",
            message: { id: "msg-pause", model: "claude-opus-5", usage: {} },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "pause_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ])
      },
    })

    const stream = await provider("claude-opus-5").stream(request())
    expect((await collect(stream.events)).at(-1)).toMatchObject({
      type: "finish",
      finishReason: "pause",
      rawFinishReason: "pause_turn",
    })
    expect(attempts).toBe(2)
  })

  test("sanitizes HTTP failures and validates convenience defaults", async () => {
    const provider = createAnthropic({
      maxRetries: 0,
      fetch: async () =>
        new Response("<html>private proxy details</html>", {
          status: 502,
          headers: { "content-type": "text/html", "request-id": "req-failure" },
        }),
    })
    const error = await provider("claude-opus-5")
      .stream(request())
      .catch((value) => value)
    expect(error).toBeInstanceOf(ModelProviderError)
    expect(String(error)).toContain("HTTP 502")
    expect(String(error)).not.toContain("private proxy details")
    expect(error).toMatchObject({ requestId: "req-failure", retryable: true })
    expect(() => createAnthropic({ baseUrl: "file:///tmp/anthropic" })).toThrow("Invalid base URL")
    expect(() => provider("   ")).toThrow("Model id must not be empty")
    expect(() => provider("claude-opus-5", { maxOutputTokens: 0 })).toThrow(
      "maxOutputTokens must be a positive integer"
    )
    expect(() => provider("claude-haiku-4-5-20251001", { maxOutputTokens: 128_000 })).toThrow(
      "must not exceed model 'claude-haiku-4-5-20251001' maximum (64000)"
    )
    const streamErrorProvider = createAnthropic({
      fetch: async () =>
        sseResponse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Provider overloaded" },
          },
        ]),
    })
    const streamError = await streamErrorProvider("claude-opus-5").stream(request())
    const streamEvents = await collect(streamError.events)
    expect(streamEvents[0]).toMatchObject({
      type: "error",
      error: { name: "ModelProviderError", code: "overloaded_error" },
    })
    expect(anthropic.providerId).toBe("anthropic")
  })

  test("decodes arbitrary SSE chunks and aborts a blocked reader", async () => {
    const text = ': ping\r\nevent: custom\r\ndata: {"one":\r\ndata: 1}\r\n\r\n'
    const bytes = new TextEncoder().encode(text)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    const events = []
    for await (const event of decodeServerSentEvents(stream, new AbortController().signal)) {
      events.push(event)
    }
    expect(events).toEqual([{ event: "custom", data: '{"one":\n1}' }])

    let cancelled = false
    const blocked = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const controller = new AbortController()
    const iterator = decodeServerSentEvents(blocked, controller.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(cancelled).toBe(true)
  })
})

function answerOutput(): ModelOutput<{ answer: string }> {
  return {
    name: "answer",
    schema: {
      type: "object",
      properties: { answer: { type: "string", pattern: "^yes$" } },
      required: ["answer"],
      additionalProperties: false,
    },
    validate(value: unknown): { answer: string } {
      if (
        typeof value !== "object" ||
        value === null ||
        (value as { answer?: unknown }).answer !== "yes"
      ) {
        throw new TypeError("answer must be yes")
      }
      return { answer: "yes" }
    },
  }
}
