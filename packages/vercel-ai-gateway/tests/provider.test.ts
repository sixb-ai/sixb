import { describe, expect, test } from "bun:test"
import type { LanguageModelRequest, LanguageModelStreamEvent } from "@sixb/core/models"
import { ModelProviderError, resolveLanguageModelDefinition } from "@sixb/core/models"
import { createVercelGateway, vercelGateway } from "../src"
import { decodeServerSentEvents } from "../src/sse"

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

describe("Vercel AI Gateway provider", () => {
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
          schema: { type: "object", properties: { answer: { type: "string" } } },
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
      tools: [{ type: "web_search_preview" }, { type: "function", name: "echo", strict: true }],
      text: { format: { type: "json_schema", name: "answer", strict: true } },
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    })
    expect(events).toEqual([
      { type: "stream-start" },
      { type: "response-metadata", id: "resp-1", modelId: "resolved-model" },
      { type: "text-start", id: "message-1:text:0" },
      { type: "text-delta", id: "message-1:text:0", delta: "Hel" },
      { type: "text-delta", id: "message-1:text:0", delta: "lo" },
      { type: "text-end", id: "message-1:text:0" },
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
      { type: "response-metadata", id: "resp-tools" },
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
      fetch: async () =>
        new Response("<html>proxy secret details</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    })("model")

    try {
      await model.stream(request())
      throw new Error("expected model.stream to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderError)
      expect(String(error)).toContain("HTTP 502")
      expect(String(error)).not.toContain("secret details")
    }
  })

  test("loads current model definitions and exact pricing from the gateway catalog", async () => {
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

    const definition = await resolveLanguageModelDefinition(gateway("creator/reasoner"))
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
        reasoning: true,
        localTools: true,
        parallelToolCalls: true,
        nativeStructuredOutput: true,
      },
      pricing: {
        currency: "USD",
        unit: "million-tokens",
        input: {
          default: "1",
          tiers: [
            { minTokens: 0, maxTokens: 100_000, price: "1" },
            { minTokens: 100_000, price: "2.5" },
          ],
        },
        output: "4",
        cacheReadInput: "0.1",
      },
    })
    expect(await gateway.catalog.list()).toHaveLength(1)
    expect(requests).toBe(1)
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
