import { describe, expect, spyOn, test } from "bun:test"
import { runModelLoop } from "@sixb/core/internal/agents"
import type { LanguageModelRequest, LanguageModelStreamEvent, ModelOutput } from "@sixb/core/models"
import { ModelCatalogUnavailableError, ModelProviderError } from "@sixb/core/models"
import { BASH_TOOL_SPEC } from "../../../packages/agent-worker/src/tools/bash"
import { READ_TOOL_SPEC } from "../../../packages/agent-worker/src/tools/read"
import { VIEW_FILE_TOOL_SPEC } from "../../../packages/agent-worker/src/tools/view-file"
import { createVercelGateway, vercelGateway } from "../src"
import { decodeServerSentEvents } from "../src/sse"
import { gatewayOutputSchema } from "../src/structured-output"

function request(overrides: Partial<LanguageModelRequest> = {}): LanguageModelRequest {
  return {
    callId: "call-1",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

// Regression proof: remove classification around fetch or body reads; offline recovery is bypassed.
test("distinguishes unavailable Gateway catalogs from malformed metadata", async () => {
  for (const fetch of [
    async () => {
      throw new TypeError("network unavailable")
    },
    async () => new Response("unavailable", { status: 503 }),
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("catalog body disconnected"))
          },
        })
      ),
  ]) {
    await expect(createVercelGateway({ fetch }).catalog.list()).rejects.toBeInstanceOf(
      ModelCatalogUnavailableError
    )
  }
  try {
    await createVercelGateway({ fetch: async () => Response.json({ wrong: [] }) }).catalog.list()
    throw new Error("Expected malformed catalog to fail")
  } catch (error) {
    expect(error).toBeInstanceOf(ModelProviderError)
    expect(error).not.toBeInstanceOf(ModelCatalogUnavailableError)
  }
  await expect(
    createVercelGateway({ fetch: async () => new Response("not JSON") }).catalog.list()
  ).rejects.toBeInstanceOf(SyntaxError)
})

// Regression proof: force strict:true for every tool; read/bash have optional non-nullable inputs.
test("preserves built-in tool schemas and only enables compatible strict decoding", async () => {
  let body: unknown
  const provider = createVercelGateway({
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return sseResponse([{ type: "response.completed", response: { status: "completed" } }])
    },
  })
  const tools = [READ_TOOL_SPEC, BASH_TOOL_SPEC, VIEW_FILE_TOOL_SPEC]
  const response = await provider("openai/test").stream(request({ tools }))
  await collect(response.events)
  expect(body).toMatchObject({
    tools: tools.map((tool, index) => ({
      type: "function",
      name: tool.name,
      parameters: tool.inputSchema,
      strict: index === 2,
    })),
  })
})

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

describe("Vercel AI Gateway provider", () => {
  test("captures native generation and request IDs from the streaming response", async () => {
    // Removal proof: omit gatewayProviderIds from response metadata.
    const provider = createVercelGateway({
      apiKey: "key",
      fetch: async () => {
        const response = sseResponse([
          { type: "response.created", response: { id: "gen_123" } },
          {
            type: "response.completed",
            response: { id: "gen_123", status: "completed", usage: {} },
          },
        ])
        response.headers.set("x-request-id", "req-native")
        return response
      },
    })
    const events = await collect((await provider("model").stream(request())).events)
    expect(events).toContainEqual({
      type: "response-metadata",
      id: "gen_123",
      providerIds: { generationId: "gen_123", responseId: "gen_123", requestId: "req-native" },
    })
  })
  test("pins resolved capabilities and output ceiling for generation", async () => {
    // Regression proof: return the original binding from resolve(), or omit definition.maxOutputTokens
    // from prepareRequest's ceiling calculation, or remove the metadataResolved capability guard.
    // Refreshing the catalog must not change this binding.
    // Removing the construction-time options snapshot must also fail the output-limit assertion.
    let catalogs = 0
    const bodies: Record<string, unknown>[] = []
    const provider = createVercelGateway({
      apiKey: "configured-key",
      fetch: async (url, init) => {
        if (String(url).endsWith("/models")) {
          catalogs += 1
          return Response.json({
            data: [
              {
                id: "creator/model",
                type: "language",
                context_window: 64_000,
                max_tokens: catalogs === 1 ? 512 : 1_024,
                supported_parameters: catalogs === 1 ? [] : ["response_format"],
              },
            ],
          })
        }
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer configured-key")
        bodies.push(JSON.parse(String(init?.body)))
        return sseResponse([])
      },
    })
    const options = { request: { max_output_tokens: 9_000 } }
    const model = provider("creator/model", options)
    options.request.max_output_tokens = 1
    const resolved = await model.resolve!()
    expect(resolved.definition.contextWindow).toBe(64_000)
    expect(resolved.definition.maxOutputTokens).toBe(512)
    await provider.catalog.refresh()
    await resolved.stream(
      request({
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
    await resolved.stream(request({ maxOutputTokens: 100 }))
    expect(bodies.map((body) => body.max_output_tokens)).toEqual([512, 100])
    expect(bodies[0]?.tools).toEqual([expect.objectContaining({ name: "sixb_structured_output" })])
    expect(bodies[0]?.text).toBeUndefined()
    expect(model.definition.contextWindow).toBeUndefined()
    expect(await resolved.resolve!()).toBe(resolved)
  })
  test("resolves model context through the shared catalog without mutating the binding", async () => {
    // Regression proof: skip catalog resolution or expire loadPromise before loadedAt is set.
    let calls = 0
    const provider = createVercelGateway({
      apiKey: "test",
      fetch: async (_url, init) => {
        calls += 1
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return Response.json({
          data: [
            {
              id: "creator/model",
              type: "language",
              context_window: 200_000,
              max_tokens: 32_000,
              tags: ["tool-use"],
            },
          ],
        })
      },
    })
    const model = provider("creator/model", { capabilities: { localTools: false } })
    const original = model.definition
    expect(calls).toBe(0)
    const [resolved, other] = await Promise.all([
      model.resolve?.(),
      provider("creator/model").resolve?.(),
    ])
    expect(calls).toBe(1)
    expect(resolved?.definition).toMatchObject({
      contextWindow: 200_000,
      capabilities: { localTools: false },
    })
    expect(other?.definition.contextWindow).toBe(200_000)
    expect(model.definition).toBe(original)
    expect(model.definition.contextWindow).toBeUndefined()
    await model.resolve?.()
    expect(calls).toBe(1)
  })

  test("resolves supplied definitions offline", async () => {
    const provider = createVercelGateway({
      models: [
        {
          kind: "language",
          providerId: "vercel-ai-gateway",
          modelId: "creator/model",
          contextWindow: 123_000,
          maxInputTokens: 100_000,
          capabilities: {},
        },
      ],
      fetch: async () => {
        throw new Error("must not fetch")
      },
    })
    expect((await provider("creator/model").resolve?.())?.definition).toMatchObject({
      contextWindow: 123_000,
      maxInputTokens: 100_000,
    })
  })

  test("reports catalog failures, retries later, and does not invent unknown model limits", async () => {
    let calls = 0
    const provider = createVercelGateway({
      apiKey: "test",
      fetch: async () => {
        if (++calls === 1) throw new Error("catalog unavailable")
        return Response.json({ data: [] })
      },
    })
    const model = provider("creator/unknown")
    await expect(model.resolve?.()).rejects.toThrow("catalog unavailable")
    expect((await model.resolve?.())?.definition).toEqual(model.definition)
    expect(model.definition.contextWindow).toBeUndefined()
    expect(calls).toBe(2)
  })
  test("honors summary output limits and automatic caching controls on the wire", async () => {
    // Regression proof: omit max_output_tokens or providerOptions from prepareRequest.
    const bodies: Record<string, unknown>[] = []
    const provider = createVercelGateway({
      apiKey: "test",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return sseResponse([])
      },
    })
    const model = provider("openai/gpt-5", { maxOutputTokens: 2_048 })
    await model.stream(request({ maxOutputTokens: 512 }))
    await model.stream(request({ maxOutputTokens: 4_096, caching: "off" }))
    expect(bodies.map((body) => body.max_output_tokens)).toEqual([512, 2_048])
    expect(bodies[0]?.providerOptions).toEqual({ gateway: { caching: "auto" } })
    expect(bodies[1]?.providerOptions).toBeUndefined()
    await expect(model.stream(request({ maxOutputTokens: 0 }))).rejects.toThrow(
      "positive safe integer"
    )
    expect(bodies).toHaveLength(2)
    expect(() => provider("openai/gpt-5", { maxOutputTokens: 0 })).toThrow("positive safe integer")
  })
  test("estimates safe Gateway settings but declines routing and extra pricing dimensions", async () => {
    // Removal proof: reject every request/providerOptions object; safe settings become unpriceable.
    const provider = createVercelGateway({
      fetch: async () =>
        Response.json({
          data: [
            {
              id: "test/model",
              type: "language",
              pricing: { input: "0.000003", output: "0.000015" },
            },
          ],
        }),
    })
    await provider.catalog.list()
    const safeOptions: import("../src/provider").VercelGatewayModelOptions[] = [
      {},
      { request: {} },
      { request: { temperature: 0.2 } },
      { providerOptions: { gateway: { caching: "off" } } },
    ]
    for (const options of safeOptions) {
      expect(
        provider("test/model", options).costEstimator?.estimate({
          usage: { inputTokens: 1000, outputTokens: 200 },
        })
      ).toMatchObject({ status: "rated", money: { amountNanos: "6000000" } })
    }
    for (const options of [
      { request: { service_tier: "priority" } },
      { providerOptions: { gateway: { models: ["other/model"] } } },
      { providerTools: [{ type: "web_search" }] },
    ]) {
      expect(
        provider("test/model", options).costEstimator?.estimate({
          usage: { inputTokens: 1000, outputTokens: 200 },
        })
      ).toMatchObject({ status: "unpriceable" })
    }
  })
  test("keeps schemas outside the strict Responses subset on the tool fallback", () => {
    expect(
      gatewayOutputSchema({
        type: "object",
        properties: { answer: { type: "string" } },
        required: [],
        additionalProperties: false,
      })
    ).toBeUndefined()
    expect(
      gatewayOutputSchema({
        type: "object",
        properties: { values: { type: "object", additionalProperties: { type: "string" } } },
        required: ["values"],
        additionalProperties: false,
      })
    ).toBeUndefined()
  })

  test("maps requests and normalizes fragmented text/usage streams", async () => {
    let capturedUrl = ""
    let capturedHeaders: Headers | undefined
    let capturedBody: Record<string, unknown> | undefined
    const provider = createVercelGateway({
      baseUrl: "https://models.example/v1/",
      apiKey: () => "secret-key",
      headers: { "x-project": "sixb" },
      fetch: async (input, init) => {
        capturedUrl = String(input)
        capturedHeaders = new Headers(init?.headers)
        capturedBody = JSON.parse(String(init?.body))
        return sseResponse([
          {
            type: "response.created",
            response: { id: "resp-1", model: "resolved-model", status: "in_progress" },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "message", id: "message-1", role: "assistant", content: [] },
          },
          {
            type: "response.content_part.added",
            item_id: "message-1",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          },
          {
            type: "response.output_text.delta",
            item_id: "message-1",
            output_index: 0,
            content_index: 0,
            delta: "Hel",
          },
          {
            type: "response.output_text.delta",
            item_id: "message-1",
            output_index: 0,
            content_index: 0,
            delta: "lo",
          },
          {
            type: "response.output_text.done",
            item_id: "message-1",
            output_index: 0,
            content_index: 0,
            text: "Hello",
          },
          {
            type: "response.completed",
            response: {
              id: "resp-1",
              status: "completed",
              usage: {
                input_tokens: 12,
                output_tokens: 5,
                input_tokens_details: { cached_tokens: 3 },
                output_tokens_details: { reasoning_tokens: 2 },
              },
              provider_metadata: {
                gateway: {
                  cost: 1e-7,
                  routing: { finalProvider: "openai" },
                  model: "resolved-model",
                },
              },
            },
          },
        ])
      },
    })
    const model = provider("creator/model", {
      providerOptions: { gateway: { order: ["one", "two"] } },
      providerTools: [{ type: "web_search_preview" }],
      capabilities: { nativeStructuredOutput: true },
    })
    const result = await model.stream(
      request({
        reasoning: "medium",
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

    expect(capturedUrl).toBe("https://models.example/v1/responses")
    expect(capturedHeaders?.get("authorization")).toBe("Bearer secret-key")
    expect(capturedHeaders?.get("x-project")).toBe("sixb")
    expect(capturedBody).toMatchObject({
      model: "creator/model",
      stream: true,
      reasoning: { effort: "medium" },
      providerOptions: { gateway: { order: ["one", "two"] } },
      tools: [{ type: "web_search_preview" }, { type: "function", name: "echo", strict: false }],
      text: { format: { type: "json_schema", name: "answer", strict: true } },
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    })
    expect(events).toEqual([
      { type: "stream-start" },
      {
        type: "response-metadata",
        id: "resp-1",
        modelId: "resolved-model",
        providerIds: { responseId: "resp-1" },
      },
      { type: "text-start", id: "message-1:text:0" },
      { type: "text-delta", id: "message-1:text:0", delta: "Hel" },
      { type: "text-delta", id: "message-1:text:0", delta: "lo" },
      { type: "text-end", id: "message-1:text:0" },
      { type: "response-metadata", providerIds: { responseId: "resp-1" } },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "completed",
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          uncachedInputTokens: 9,
          cacheReadInputTokens: 3,
          textOutputTokens: 3,
          reasoningOutputTokens: 2,
          raw: {
            input_tokens: 12,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 3 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
        providerData: {
          "vercel-ai-gateway": {
            cost: 1e-7,
            routing: { finalProvider: "openai" },
            model: "resolved-model",
          },
        },
        reportedCost: {
          money: { currency: "USD", amountNanos: "100" },
          providerId: "vercel-ai-gateway",
        },
        route: { providerId: "openai", modelId: "resolved-model" },
      },
    ])
  })

  test("resolves native structured output through the callable provider path", async () => {
    const requested: string[] = []
    let responseBody: Record<string, unknown> | undefined
    const gateway = createVercelGateway({
      baseUrl: "https://models.example/v1",
      apiKey: "secret-key",
      fetch: async (input, init) => {
        const url = String(input)
        requested.push(url)
        if (url.endsWith("/models")) {
          return Response.json({
            data: [
              {
                id: "creator/model",
                type: "language",
                supported_parameters: ["response_format"],
              },
            ],
          })
        }
        responseBody = JSON.parse(String(init?.body))
        return sseResponse([
          {
            type: "response.created",
            response: { id: "resp-structured-native", model: "creator/model" },
          },
          {
            type: "response.content_part.added",
            item_id: "message-output",
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "" },
          },
          {
            type: "response.output_text.delta",
            item_id: "message-output",
            output_index: 0,
            content_index: 0,
            delta: '{"answer":"yes"}',
          },
          {
            type: "response.output_text.done",
            item_id: "message-output",
            output_index: 0,
            content_index: 0,
            text: '{"answer":"yes"}',
          },
          {
            type: "response.completed",
            response: {
              id: "resp-structured-native",
              status: "completed",
              usage: { input_tokens: 8, output_tokens: 5 },
            },
          },
        ])
      },
    })

    const result = await runModelLoop({
      model: gateway("creator/model"),
      messages: [{ role: "user", content: [{ type: "text", text: "Answer yes." }] }],
      output: answerOutput(),
      maxSteps: 1,
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ status: "completed", output: { answer: "yes" } })
    expect(requested).toEqual([
      "https://models.example/v1/models",
      "https://models.example/v1/responses",
    ])
    expect(responseBody).toMatchObject({
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema: answerOutput().schema,
          strict: true,
        },
      },
    })
    expect(responseBody?.tools).toBeUndefined()
  })

  test("hides a required nonparallel JSON tool when native output is unavailable", async () => {
    let responseBody: Record<string, unknown> | undefined
    const gateway = createVercelGateway({
      baseUrl: "https://models.example/v1",
      apiKey: "secret-key",
      fetch: async (_input, init) => {
        responseBody = JSON.parse(String(init?.body))
        return sseResponse([
          {
            type: "response.created",
            response: { id: "resp-structured-tool", model: "creator/legacy" },
          },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "item-output",
              call_id: "call-output",
              name: "sixb_structured_output",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-output",
            output_index: 0,
            delta: '{"answer":',
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "item-output",
            output_index: 0,
            delta: '"yes"}',
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "item-output",
            output_index: 0,
            arguments: '{"answer":"yes"}',
          },
          {
            type: "response.completed",
            response: {
              id: "resp-structured-tool",
              status: "completed",
              usage: { input_tokens: 8, output_tokens: 5 },
            },
          },
        ])
      },
    })

    const result = await runModelLoop({
      model: gateway("creator/legacy", {
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
    expect(responseBody).toMatchObject({
      tool_choice: "required",
      parallel_tool_calls: false,
      tools: [
        {
          type: "function",
          name: "sixb_structured_output",
          parameters: answerOutput().schema,
        },
      ],
    })
    expect(responseBody?.text).toBeUndefined()
  })

  // Regression proof: restore the unsupported-effort throw in gatewayReasoningRequest.
  test("warns and delivers the response with default reasoning for unsupported efforts", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (const reasoning of [false, {}, { efforts: ["high"] }] as const) {
        let body: Record<string, unknown> | undefined
        const model = createVercelGateway({
          fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body))
            return sseResponse([
              { type: "response.output_text.delta", delta: "Hello back" },
              { type: "response.completed", response: { status: "completed" } },
            ])
          },
        })("zai/glm-5.3-flash", { capabilities: { reasoning } })
        const response = await model.stream(request({ reasoning: "medium" }))
        const events = await collect(response.events)
        expect(body?.reasoning).toBeUndefined()
        expect(body?.input).toBeDefined()
        expect(events).toContainEqual(
          expect.objectContaining({ type: "text-delta", delta: "Hello back" })
        )
      }
      expect(warn).toHaveBeenCalledTimes(3)
      expect(warn).toHaveBeenLastCalledWith(
        "[SixbVercelGateway] Model 'zai/glm-5.3-flash' reasoning effort 'medium' is not supported. Using provider-default reasoning instead."
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("rejects exact budgets that the Gateway Responses API cannot represent", async () => {
    let requests = 0
    const model = createVercelGateway({
      apiKey: "secret-key",
      fetch: async () => {
        requests += 1
        throw new Error("Unexpected fetch")
      },
    })("creator/reasoner")

    await expect(model.stream(request({ reasoning: { budgetTokens: 4_096 } }))).rejects.toThrow(
      "Exact reasoning token budgets are not supported"
    )
    expect(requests).toBe(0)
  })

  test("streams tool arguments and preserves exact provider replay items", async () => {
    let capturedBody: Record<string, unknown> | undefined
    const provider = createVercelGateway({
      baseUrl: "https://models.example/v1",
      fetch: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body))
        return sseResponse([
          { type: "response.created", response: { id: "resp-tools", status: "in_progress" } },
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc-item",
              call_id: "fc-1",
              name: "echo",
              arguments: "",
            },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc-item",
            output_index: 0,
            delta: '{"value":',
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: "fc-item",
            output_index: 0,
            delta: '"hi"}',
          },
          {
            type: "response.function_call_arguments.done",
            item_id: "fc-item",
            output_index: 0,
            arguments: '{"value":"hi"}',
          },
          {
            type: "response.output_item.done",
            output_index: 1,
            item: { type: "web_search_call", id: "search-1", status: "completed" },
          },
          {
            type: "response.completed",
            response: { id: "resp-tools", status: "completed", usage: {} },
          },
        ])
      },
    })
    const model = provider("tool-model")
    const result = await model.stream(
      request({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Before provider state." },
              {
                type: "provider-state",
                providerId: "vercel-ai-gateway",
                data: {
                  item: { type: "reasoning", id: "reasoning-1", encrypted_content: "signed" },
                },
              },
              {
                type: "tool-call",
                toolCallId: "old-call",
                toolName: "echo",
                input: { value: "old" },
                providerData: {
                  "vercel-ai-gateway": {
                    item: {
                      type: "function_call",
                      id: "old-item",
                      call_id: "old-call",
                      name: "echo",
                      arguments: '{"value":"old"}',
                    },
                  },
                },
              },
              { type: "text", text: "After tool call." },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "old-call",
                toolName: "echo",
                output: { type: "json", value: { echoed: "old" } },
              },
            ],
          },
        ],
      })
    )
    const events = await collect(result.events)

    expect(capturedBody?.input).toEqual([
      {
        role: "assistant",
        content: [{ type: "output_text", text: "Before provider state." }],
      },
      { type: "reasoning", id: "reasoning-1", encrypted_content: "signed" },
      {
        type: "function_call",
        id: "old-item",
        call_id: "old-call",
        name: "echo",
        arguments: '{"value":"old"}',
      },
      {
        role: "assistant",
        content: [{ type: "output_text", text: "After tool call." }],
      },
      { type: "function_call_output", call_id: "old-call", output: '{"echoed":"old"}' },
    ])
    expect(events.slice(0, 5)).toEqual([
      { type: "stream-start" },
      { type: "response-metadata", id: "resp-tools", providerIds: { responseId: "resp-tools" } },
      { type: "tool-input-start", id: "fc-1", toolName: "echo" },
      { type: "tool-input-delta", id: "fc-1", delta: '{"value":' },
      { type: "tool-input-delta", id: "fc-1", delta: '"hi"}' },
    ])
    expect(events[5]).toMatchObject({
      type: "tool-input-end",
      id: "fc-1",
      providerData: {
        "vercel-ai-gateway": {
          item: {
            type: "function_call",
            call_id: "fc-1",
            name: "echo",
            arguments: '{"value":"hi"}',
          },
        },
      },
    })
    expect(events).toContainEqual({
      type: "provider-state",
      providerId: "vercel-ai-gateway",
      data: {
        item: { type: "web_search_call", id: "search-1", status: "completed" },
      },
    })
    expect(events.at(-1)).toMatchObject({ type: "finish", finishReason: "tool-calls" })
  })

  test("sanitizes provider HTTP failures and validates convenience defaults", async () => {
    const gateway = createVercelGateway({ apiKey: "key" })
    expect(gateway.providerId).toBe("vercel-ai-gateway")
    expect(vercelGateway.providerId).toBe("vercel-ai-gateway")

    expect(() => gateway("model", { request: { generatedAt: new Date() } as never })).toThrow(
      "model request options"
    )

    const model = createVercelGateway({
      baseUrl: "https://models.example/v1",
      maxRetries: 0,
      fetch: async () =>
        new Response("<html>proxy secret details</html>", {
          status: 502,
          headers: {
            "content-type": "text/html",
            "x-request-id": "gateway-request-failure",
          },
        }),
    })("model")

    try {
      await model.stream(request())
      throw new Error("expected model.stream to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderError)
      expect(String(error)).toContain("HTTP 502")
      expect(String(error)).not.toContain("secret details")
      expect(error).toMatchObject({ requestId: "gateway-request-failure", retryable: true })
    }
  })

  test("retries retryable pre-stream gateway responses", async () => {
    let attempts = 0
    const model = createVercelGateway({
      maxRetries: 1,
      fetch: async () => {
        attempts += 1
        if (attempts === 1) {
          return Response.json(
            { error: { code: "temporarily_unavailable", message: "try again" } },
            {
              status: 503,
              headers: { "x-request-id": "gateway-retry", "retry-after-ms": "0" },
            }
          )
        }
        return sseResponse([
          { type: "response.created", response: { id: "response-retried" } },
          {
            type: "response.completed",
            response: { id: "response-retried", status: "completed", usage: {} },
          },
        ])
      },
    })("creator/model")

    const stream = await model.stream(request())
    expect((await collect(stream.events)).at(-1)).toMatchObject({
      type: "finish",
      finishReason: "stop",
    })
    expect(attempts).toBe(2)
  })

  test("keeps catalog discovery off model construction and exposes fixed gateway rates", async () => {
    let requests = 0
    const gateway = createVercelGateway({
      fetch: async () => {
        requests += 1
        return Response.json({
          object: "list",
          data: [
            {
              id: "creator/reasoner",
              type: "language",
              owned_by: "creator",
              name: "Reasoner",
              description: "A test model.",
              released: 1_767_225_600,
              knowledge: "2025-06",
              context_window: 200_000,
              max_tokens: 32_000,
              tags: ["reasoning", "tool-use", "vision", "file-input"],
              reasoning_options: [
                { type: "toggle" },
                { type: "effort", values: ["low", "medium", "high", "xhigh", "max"] },
              ],
              modalities: { input: ["text", "image", "pdf"], output: ["text"] },
              supported_parameters: ["tools", "response_format"],
              pricing: {
                input: "0.000001",
                input_tiers: [
                  { cost: "0.000001", min: 0, max: 100_000 },
                  { cost: "0.0000025", min: 100_000 },
                ],
                output: "0.000004",
                input_cache_read: "0.0000001",
              },
            },
            { id: "creator/image", type: "image", pricing: { image: "0.05" } },
          ],
        })
      },
    })

    const model = gateway("creator/reasoner")
    expect(requests).toBe(0)
    expect(model.definition).toEqual({
      kind: "language",
      providerId: "vercel-ai-gateway",
      modelId: "creator/reasoner",
      capabilities: {},
    })

    const definition = await gateway.catalog.get("creator/reasoner")
    expect(definition).toEqual({
      kind: "language",
      providerId: "vercel-ai-gateway",
      modelId: "creator/reasoner",
      name: "Reasoner",
      description: "A test model.",
      family: "creator",
      tags: ["reasoning", "tool-use", "vision", "file-input"],
      releaseDate: "2026-01-01",
      knowledgeCutoff: "2025-06",
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      capabilities: {
        inputMediaTypes: ["image/*", "application/pdf"],
        reasoning: {
          canDisable: true,
          efforts: ["low", "medium", "high", "xhigh", "max"],
        },
        localTools: true,
        parallelToolCalls: true,
        nativeStructuredOutput: true,
      },
    })
    expect(await gateway.catalog.list()).toHaveLength(1)
    // Regression proof: omit the routed/response model check; a fallback gets the requested model's price.
    expect(
      gateway("creator/reasoner").costEstimator?.estimate({
        usage: { inputTokens: 1, uncachedInputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
        route: { modelId: "other/model" },
      })
    ).toEqual({ status: "unpriceable", reason: "missing-rate-card" })
    expect(
      gateway("creator/reasoner").costEstimator?.estimate({
        usage: {
          inputTokens: 200_000,
          uncachedInputTokens: 200_000,
          outputTokens: 10,
          cacheReadInputTokens: 0,
        },
      })
    ).toMatchObject({ status: "rated", money: { amountNanos: "500040000" } })
    expect(requests).toBe(1)
    await gateway.catalog.refresh()
    expect(requests).toBe(2)
  })

  test("decodes CRLF, comments, repeated data lines, and arbitrary chunks", async () => {
    const text = ': ping\r\nevent: custom\r\ndata: {"one":\r\ndata: 1}\r\n\r\n'
    const bytes = new TextEncoder().encode(text)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    const events = []
    for await (const event of decodeServerSentEvents(body, new AbortController().signal)) {
      events.push(event)
    }
    expect(events).toEqual([{ event: "custom", data: '{"one":\n1}' }])
  })

  test("cancels a blocked SSE reader when the model signal aborts", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const abort = new AbortController()
    const iterator = decodeServerSentEvents(body, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    abort.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(cancelled).toBe(true)
  })
})

function answerOutput(): ModelOutput<{ answer: string }> {
  return {
    name: "answer",
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
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
