import { expect, test } from "bun:test"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type {
  JsonObject,
  LanguageModelRequest,
  LanguageModelStreamEvent,
  ModelMessage,
} from "@sixb/core/models"
import { agentTraceFromModelSteps } from "../../../packages/agent-worker/src/model-adapters"
import { foundryMessagesEstimator, foundryMessagesUsage } from "../src/messages-accounting"
import { messagesOutputSchema } from "../src/messages-schema"
import { createAzureAIFoundry } from "./provider-fixture"

const endpoint = "https://resource.services.ai.azure.com"
const schema: JsonObject = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
}
const definition = {
  maxOutputTokens: 4096,
  capabilities: {
    localTools: true,
    parallelToolCalls: true,
    nativeStructuredOutput: true,
    reasoning: {
      canDisable: true,
      efforts: ["low", "high", "xhigh", "max"] as const,
      budgetTokens: { min: 1024 },
    },
    inputMediaTypes: ["image/png", "application/pdf"],
  },
}
const metadata = { publisher: "Anthropic", modelName: "claude-sonnet-4-6", modelVersion: "1" }
const rateCard = {
  currency: "USD",
  unit: "million-tokens",
  input: "3",
  output: "15",
  cacheReadInput: "0.3",
  cacheWriteInput5m: "3.75",
  cacheWriteInput1h: "6",
} as const
const rawUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 5,
  cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 2 },
}

function request(overrides: Partial<LanguageModelRequest> = {}): LanguageModelRequest {
  return {
    callId: "call",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

function sse(events: readonly JsonObject[]): Response {
  const bytes = new TextEncoder().encode(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
  )
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      },
    }),
    { headers: { "apim-request-id": "azure-request" } }
  )
}

function message(
  blocks: JsonObject[] = [{ type: "text", text: "Done." }],
  reason = "end_turn",
  usage: JsonObject = rawUsage
): Response {
  return sse([
    {
      type: "message_start",
      message: { id: "msg", model: metadata.modelName, usage: { ...usage, output_tokens: 0 } },
    },
    ...blocks.flatMap((block, index): JsonObject[] => [
      { type: "content_block_start", index, content_block: block },
      { type: "content_block_stop", index },
    ]),
    {
      type: "message_delta",
      delta: { stop_reason: reason },
      usage: { output_tokens: usage.output_tokens ?? 5 },
    },
    { type: "message_stop" },
  ])
}

async function collect(
  events: AsyncIterable<LanguageModelStreamEvent>
): Promise<LanguageModelStreamEvent[]> {
  const result: LanguageModelStreamEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

test.each([
  "",
  "/",
  "/anthropic",
  "/anthropic/v1",
  "/openai/v1",
])("uses native Messages endpoint and Azure key headers from %s", async (suffix) => {
  let captured: JsonObject | undefined
  const provider = createAzureAIFoundry({
    endpoint: endpoint + suffix,
    apiKey: "azure-key",
    fetch: async (url, init) => {
      expect(String(url)).toBe(`${endpoint}/anthropic/v1/messages`)
      const headers = new Headers(init?.headers)
      expect(headers.get("x-api-key")).toBe("azure-key")
      expect(headers.has("api-key")).toBe(false)
      expect(headers.has("authorization")).toBe(false)
      expect(headers.get("anthropic-version")).toBe("2023-06-01")
      captured = JSON.parse(String(init?.body))
      return message()
    },
  })
  const model = provider.messages("support-prod", { definition, metadata })
  expect(model.protocol).toBe("messages")
  expect(model.modelId).toBe("support-prod")
  expect(await model.resolve()).toBe(model)
  expect(await model.resolve({ offline: true })).toBe(model)
  const events = await collect((await model.stream(request({ maxOutputTokens: 128 }))).events)
  expect(captured).toEqual({
    model: "support-prod",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    stream: true,
    max_tokens: 128,
  })
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "response-metadata",
      modelId: metadata.modelName,
      providerIds: { responseId: "msg", requestId: "azure-request" },
    })
  )
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    finishReason: "stop",
    usage: {
      inputTokens: 35,
      uncachedInputTokens: 10,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 5,
      outputTokens: 5,
    },
  })
})

test("keeps Responses defaults and rejects ambiguous project Messages bindings", () => {
  const provider = createAzureAIFoundry({ endpoint, apiKey: "key" })
  expect(provider("deployment").protocol).toBe("responses")
  expect(provider.responses("deployment").protocol).toBe("responses")
  expect(() =>
    createAzureAIFoundry({ endpoint: `${endpoint}/api/projects/example`, apiKey: "key" }).messages(
      "deployment"
    )
  ).toThrow("resource endpoint")
})

test("refreshes native Entra credentials on retries and preserves native HTTP error codes", async () => {
  let attempt = 0
  const tokens: string[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: async () => `token-${++attempt}`,
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers)
      tokens.push(headers.get("authorization")!)
      expect(headers.has("x-api-key")).toBe(false)
      if (attempt === 1)
        return Response.json(
          { error: { type: "overloaded_error", message: "busy" } },
          { status: 529, headers: { "retry-after-ms": "0" } }
        )
      return message()
    },
  })
  await collect((await provider.messages("deployment", { definition }).stream(request())).events)
  expect(tokens).toEqual(["Bearer token-1", "Bearer token-2"])
  const broken = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    maxRetries: 0,
    fetch: async () =>
      Response.json(
        { error: { type: "invalid_request_error", message: "invalid model" } },
        { status: 400, headers: { "request-id": "native-error" } }
      ),
  }).messages("deployment", { definition })
  await expect(broken.stream(request())).rejects.toMatchObject({
    name: "ModelProviderError",
    code: "invalid_request_error",
    requestId: "native-error",
    modelId: "deployment",
    status: 400,
  })
})

test("cancels native credential acquisition before inference", async () => {
  const controller = new AbortController()
  const model = createAzureAIFoundry({
    endpoint,
    tokenProvider: (signal) => {
      expect(signal).toBe(controller.signal)
      controller.abort(new Error("cancelled"))
      return new Promise<string>(() => {})
    },
    fetch: async () => {
      throw new Error("must not fetch")
    },
  }).messages("deployment", { definition })
  await expect(model.stream(request({ signal: controller.signal }))).rejects.toThrow("cancelled")
})

test("snapshots native configuration and merges capabilities without deriving facts from deployment names", async () => {
  let body: JsonObject | undefined
  const options = {
    definition: { maxOutputTokens: 80, capabilities: { localTools: false } },
    metadata: { ...metadata },
    request: { temperature: 0.2 },
    rateCard: { ...rateCard },
  }
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    models: [
      {
        kind: "language",
        providerId: "azure-ai-foundry",
        modelId: "claude-mythos-5",
        ...definition,
      },
    ],
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return message()
    },
  })
  const model = provider.messages("claude-mythos-5", options)
  options.definition.maxOutputTokens = 999
  options.metadata.modelName = "changed"
  options.request.temperature = 0.9
  options.rateCard.input = "999" as "3"
  await collect((await model.stream(request())).events)
  expect(body).toMatchObject({ model: "claude-mythos-5", max_tokens: 80, temperature: 0.2 })
  expect(model.definition.capabilities).toMatchObject({
    localTools: false,
    nativeStructuredOutput: true,
  })
  expect(model.metadata.modelName).toBe(metadata.modelName)
  expect(Object.isFrozen(model)).toBe(true)
  expect(
    model.costEstimator?.estimate({
      usage: foundryMessagesUsage(rawUsage),
      responseModelId: metadata.modelName,
    })
  ).toMatchObject({ status: "rated", money: { amountNanos: "134250" } })
})

test("applies explicit capability gates and requires a bounded max_tokens", async () => {
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => {
      throw new Error("must not fetch")
    },
  })
  const model = provider.messages("unknown", { maxOutputTokens: 2048 })
  for (const override of [
    { tools: [{ name: "tool", description: "Tool", inputSchema: schema }] },
    { reasoning: "high" as const },
    { responseFormat: { type: "json" as const, name: "answer", schema } },
  ])
    await expect(model.stream(request(override))).rejects.toMatchObject({
      name: "UnsupportedModelFeatureError",
    })
  await expect(provider.messages("unknown").stream(request())).rejects.toThrow(
    "requires maxOutputTokens"
  )
  await expect(model.stream(request({ maxOutputTokens: 0 }))).rejects.toThrow(
    "positive safe integer"
  )
})

test("maps manual and adaptive thinking using declared model metadata", async () => {
  const bodies: JsonObject[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return message()
    },
  })
  const model = provider.messages("arbitrary-deployment", { definition, metadata })
  for (const reasoning of ["high", { budgetTokens: 1024 }, "none", "provider-default"] as const)
    await collect((await model.stream(request({ reasoning }))).events)
  expect(bodies[0]).toMatchObject({
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  })
  expect(bodies[1]).toMatchObject({ thinking: { type: "enabled", budget_tokens: 1024 } })
  expect(bodies[2]).toMatchObject({ thinking: { type: "disabled" } })
  expect(bodies[3]?.thinking).toBeUndefined()
  await expect(
    model.stream(request({ reasoning: { budgetTokens: 1024 }, maxOutputTokens: 1024 }))
  ).rejects.toThrow("below maxOutputTokens")
  await collect((await model.stream(request({ reasoning: "xhigh" }))).events)
  const future = provider.messages("future", { definition, thinkingMode: "adaptive" })
  await collect((await future.stream(request({ reasoning: "high" }))).events)
  await expect(
    provider
      .messages("future", { definition, thinkingMode: "manual" })
      .stream(request({ reasoning: "high" }))
  ).rejects.toThrow("reasoning effort 'high' is not supported")
})

test("explicit thinking mode restricts manual budgets without model-name rules", async () => {
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => {
      throw new Error("must not fetch")
    },
  })
  const opus = provider.messages("production", {
    definition,
    thinkingMode: "adaptive",
    metadata: { publisher: "Anthropic", modelName: "claude-opus-4-8", modelVersion: "2" },
  })
  await expect(opus.stream(request({ reasoning: { budgetTokens: 1024 } }))).rejects.toThrow(
    "reasoning token budgets are not supported"
  )
  expect(
    createAzureAIFoundry({ endpoint, tokenProvider: () => "token" }).messages("production", {
      metadata: { modelName: "claude-mythos-5" },
    }).protocol
  ).toBe("messages")
})

test("owns native request fields and validates cache controls", () => {
  const provider = createAzureAIFoundry({ endpoint, apiKey: "key" })
  for (const key of [
    "messages",
    "tools",
    "tool_choice",
    "thinking",
    "max_tokens",
    "output_config",
    "output_format",
    "container",
    "mcp_servers",
    "context_management",
  ])
    expect(() => provider.messages("deployment", { request: { [key]: {} } })).toThrow(
      "owned by the adapter"
    )
  const invalid: JsonObject[] = [
    { type: "persistent" },
    { type: "ephemeral", ttl: "2h" },
    { type: "ephemeral", extra: true },
  ]
  for (const cache_control of invalid)
    expect(() => provider.messages("deployment", { request: { cache_control } })).toThrow(
      "cache_control"
    )
})

test("sends exact Claude schemas and strict tools; optional properties need not be required", async () => {
  const bodies: JsonObject[] = []
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return message()
    },
  }).messages("deployment", { definition, metadata })
  const optional = { ...schema, required: [] }
  const tools = [{ name: "answer", description: "Answer", inputSchema: optional }]
  await collect(
    (
      await model.stream(
        request({
          tools,
          reasoning: "high",
          responseFormat: { type: "json", name: "answer", schema: optional },
        })
      )
    ).events
  )
  expect(bodies[0]).toMatchObject({
    output_config: { effort: "high", format: { type: "json_schema", schema: optional } },
    tools: [{ input_schema: optional, strict: true }],
    tool_choice: { type: "auto", disable_parallel_tool_use: false },
  })
  const constrained = { ...schema, properties: { answer: { type: "string", minLength: 1 } } }
  await collect(
    (await model.stream(request({ tools: [{ ...tools[0]!, inputSchema: constrained }] }))).events
  )
  expect(bodies[1]?.tools).toEqual([
    { name: "answer", description: "Answer", input_schema: constrained },
  ])
  await expect(
    model.stream(request({ responseFormat: { type: "json", name: "answer", schema: constrained } }))
  ).rejects.toThrow("Claude schema")
  expect(bodies).toHaveLength(2)
})

test("validates the conservative Claude schema subset without rewriting contracts", () => {
  const supported: JsonObject = {
    type: "object",
    properties: {
      choice: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
      list: { type: "array", items: { type: "integer", enum: [1, 2] } },
    },
    additionalProperties: false,
  }
  expect(messagesOutputSchema(supported)).toBe(supported)
  const invalid: JsonObject[] = [
    { type: "number", minimum: 0 },
    { $ref: "#/missing" },
    { type: "string", pattern: "x" },
    { type: "object", properties: {} },
    { type: "array" },
    { type: "string", format: "made-up" },
  ]
  for (const child of invalid)
    expect(messagesOutputSchema({ ...schema, properties: { answer: child } })).toBeUndefined()
  expect(messagesOutputSchema({ ...schema, required: ["missing"] })).toBeUndefined()
})

test("serializes supported images/PDFs with aggregate byte limits and stable system instructions", async () => {
  let body: JsonObject | undefined
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return message()
    },
  }).messages("deployment", { definition, maxInputFileBytes: 10 })
  const messages: ModelMessage[] = [
    { role: "system", content: "Instructions" },
    {
      role: "user",
      content: [
        {
          type: "file",
          mediaType: "application/pdf",
          data: new URL("data:application/pdf;base64,JVBERi0="),
        },
        { type: "file", mediaType: "image/png", data: new URL("data:image/png;base64,aW1hZ2U=") },
        {
          type: "file",
          mediaType: "application/pdf",
          data: new URL("https://example.com/report.pdf"),
        },
      ],
    },
  ]
  await collect((await model.stream(request({ messages }))).events)
  expect(body).toMatchObject({
    system: [{ type: "text", text: "Instructions" }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
          },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
          { type: "document", source: { type: "url", url: "https://example.com/report.pdf" } },
        ],
      },
    ],
  })
  await expect(
    model.stream(request({ messages: [...messages, { role: "system", content: "Later" }] }))
  ).rejects.toThrow("must precede")
  for (const data of [
    "file:///report.pdf",
    "https://user:pass@example.com/report.pdf",
    "data:image/png;base64,JVBERi0=",
    "data:application/pdf;base64,***",
    "data:application/pdf;base64,MDEyMzQ1Njc4OTE=",
  ])
    await expect(
      model.stream(
        request({
          messages: [
            {
              role: "user",
              content: [{ type: "file", mediaType: "application/pdf", data: new URL(data) }],
            },
          ],
        })
      )
    ).rejects.toBeInstanceOf(Error)
})

// Regression proof: bypass validateMessages in foundryMessagesRequest. The cross-deployment
// assertion fails because another inference call receives the signed/redacted history.
test("runs local tools with fragmented signatures, redacted thinking, and durable scoped replay", async () => {
  const bodies: JsonObject[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length !== 1) return message()
      return sse([
        {
          type: "message_start",
          message: { id: "first", model: metadata.modelName, usage: rawUsage },
        },
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
          delta: { type: "signature_delta", signature: "thinking" },
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
          content_block: { type: "tool_use", id: "call-tool", name: "check", input: {} },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "{" },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "}" },
        },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 10 } },
        { type: "message_stop" },
      ])
    },
  })
  const model = provider.messages("deployment", { definition, metadata, rateCard })
  let executed = 0
  const result = await runModelLoop({
    model,
    messages: request().messages,
    signal: request().signal,
    maxSteps: 2,
    tools: [
      {
        name: "check",
        description: "Check",
        inputSchema: { type: "object", properties: {} },
        parseInput: (input) => input,
        execute: async () => {
          executed++
          return "ok"
        },
        errorText: () => "failed",
      },
    ],
  })
  expect(result.status).toBe("completed")
  expect(executed).toBe(1)
  const thinking = { type: "thinking", thinking: "Réfléchir", signature: "signed-thinking" }
  const redacted = { type: "redacted_thinking", data: "opaque" }
  expect(bodies[1]?.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    {
      role: "assistant",
      content: [
        thinking,
        redacted,
        { type: "tool_use", id: "call-tool", name: "check", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-tool", content: "ok" }] },
  ])
  const history = toModelMessages([
    {
      role: "assistant",
      parts: JSON.parse(JSON.stringify(agentTraceFromModelSteps(result.steps))),
    },
  ])
  await collect((await model.stream(request({ messages: history }))).events)
  expect(JSON.stringify(bodies[2]?.messages)).toContain("signed-thinking")
  expect(JSON.stringify(bodies[2]?.messages)).toContain("opaque")
  await expect(
    provider.messages("other", { definition }).stream(request({ messages: history }))
  ).rejects.toThrow("different endpoint, deployment, or protocol")
  await expect(
    provider.responses("deployment", { definition }).stream(request({ messages: history }))
  ).rejects.toThrow("different endpoint, deployment, or protocol")
  await expect(
    createAzureAIFoundry({ endpoint: "https://other.services.ai.azure.com", apiKey: "key" })
      .messages("deployment", { definition })
      .stream(request({ messages: history }))
  ).rejects.toThrow("different endpoint")
  expect(bodies).toHaveLength(3)
})

// Regression proof: remove the provider usage hook in Messages MessageState. The shared
// Anthropic default fills missing cache counters with zero and invents a complete input total.
test("preserves missing usage partitions and cumulative usage without double counting", async () => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => message(undefined, "end_turn", { input_tokens: 10, output_tokens: 5 }),
  }).messages("deployment", { definition, rateCard })
  const finish = (await collect((await model.stream(request())).events)).at(-1)
  if (finish?.type !== "finish") throw new Error("missing finish")
  expect(finish.usage.inputTokens).toBeUndefined()
  expect(finish.usage.cacheReadInputTokens).toBeUndefined()
  expect(finish.usage.cacheWriteInputTokens).toBeUndefined()
  expect(finish.usage.textOutputTokens).toBeUndefined()
  expect(finish.usage.outputTokens).toBe(5)
  expect(model.costEstimator?.estimate({ usage: finish.usage })).toMatchObject({
    status: "unpriceable",
    reason: "missing-usage",
  })
  const partial = foundryMessagesUsage({
    input_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 3 },
  })
  expect(partial.inputTokens).toBeUndefined()
  expect(partial.cacheWrite1hInputTokens).toBeUndefined()
  const full = foundryMessagesUsage({ ...rawUsage, output_tokens_details: { thinking_tokens: 2 } })
  expect(full).toMatchObject({
    inputTokens: 35,
    cacheWrite5mInputTokens: 3,
    cacheWrite1hInputTokens: 2,
    reasoningOutputTokens: 2,
    textOutputTokens: 3,
  })
})

test("prices explicit cache TTLs conservatively and declines unknown charges and hosting-version model drift", () => {
  const estimator = foundryMessagesEstimator(rateCard, undefined, metadata.modelName)
  const usage = foundryMessagesUsage(rawUsage)
  expect(estimator.estimate({ usage, responseModelId: metadata.modelName })).toMatchObject({
    status: "rated",
    money: { amountNanos: "134250" },
  })
  expect(estimator.estimate({ usage, responseModelId: `${metadata.modelName}-1` })).toMatchObject({
    status: "unpriceable",
  })
  expect(estimator.estimateReservation?.({ inputTokens: 10, outputTokens: 5 })).toEqual({
    currency: "USD",
    amountNanos: "135000",
  })
  const extras: JsonObject[] = [
    { server_tool_use: { web_search_requests: 1 } },
    { inference_geo: "us" },
    { service_tier: "fast" },
    { future_meter: 0 },
  ]
  for (const extra of extras)
    expect(
      estimator.estimate({ usage: foundryMessagesUsage({ ...rawUsage, ...extra }) })
    ).toMatchObject({ status: "unpriceable" })
  expect(
    estimator.estimate({
      usage: foundryMessagesUsage({
        ...rawUsage,
        server_tool_use: { web_search_requests: 0 },
        service_tier: "standard",
      }),
    })
  ).toMatchObject({ status: "rated" })
  expect(
    estimator.estimate({
      usage: foundryMessagesUsage({ ...rawUsage, cache_creation_input_tokens: 8 }),
    })
  ).toMatchObject({ status: "unpriceable", reason: "inconsistent-usage" })
  expect(foundryMessagesEstimator(undefined, undefined).estimate({ usage })).toMatchObject({
    status: "unpriceable",
    reason: "missing-rate-card",
  })
  const customTier = foundryMessagesEstimator(rateCard, { service_tier: "auto" })
  expect(customTier.estimate({ usage })).toMatchObject({ status: "unpriceable" })
  expect(customTier.estimateReservation?.({ inputTokens: 10, outputTokens: 5 })).toBeUndefined()
})

test.each([
  "5m",
  "1h",
])("keeps explicit %s cache control when automatic caching is off", async (ttl) => {
  let body: JsonObject | undefined
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return message()
    },
  }).messages("deployment", {
    definition,
    rateCard,
    request: { cache_control: { type: "ephemeral", ttl } },
  })
  await collect((await model.stream(request({ caching: "off" }))).events)
  expect(body?.cache_control).toEqual({ type: "ephemeral", ttl })
  expect(model.costEstimator?.estimate({ usage: foundryMessagesUsage(rawUsage) })).toMatchObject({
    status: "rated",
  })
})

test.each([
  ["end_turn", "stop"],
  ["stop_sequence", "stop"],
  ["max_tokens", "length"],
  ["model_context_window_exceeded", "length"],
  ["pause_turn", "pause"],
  ["refusal", "content-filter"],
  ["new_reason", "other"],
])("maps native stop reason %s to %s", async (reason, expected) => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => message([], reason),
  }).messages("deployment", { definition })
  expect((await collect((await model.stream(request())).events)).at(-1)).toMatchObject({
    type: "finish",
    finishReason: expected,
    rawFinishReason: reason,
  })
})

test("preserves streamed native errors and rejects unterminated streams", async () => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      sse([{ type: "error", error: { type: "overloaded_error", message: "busy" } }]),
  }).messages("deployment", { definition })
  expect(await collect((await model.stream(request())).events)).toEqual([
    expect.objectContaining({
      type: "error",
      error: expect.objectContaining({
        code: "overloaded_error",
        requestId: "azure-request",
        providerId: "azure-ai-foundry",
        modelId: "deployment",
      }),
    }),
  ])
  const broken = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => sse([{ type: "message_start", message: { id: "msg" } }]),
  }).messages("deployment", { definition })
  await expect(collect((await broken.stream(request())).events)).rejects.toThrow(
    "without a terminal message"
  )
})

test("retains native usage and cost when structured output fails local validation", async () => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => message([{ type: "text", text: '{"answer":123}' }]),
  }).messages("deployment", { definition, rateCard, metadata })
  const result = runModelLoop({
    model,
    messages: request().messages,
    signal: request().signal,
    maxSteps: 1,
    tools: [],
    output: {
      name: "answer",
      schema,
      validate: () => {
        throw new Error("answer must be a string")
      },
    },
  })
  await expect(result).rejects.toMatchObject({
    name: "StructuredOutputError",
    usage: { inputTokens: 35, outputTokens: 5 },
    cost: { status: "rated", money: { amountNanos: "134250" } },
  })
})
