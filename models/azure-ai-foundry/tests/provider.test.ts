import { expect, test } from "bun:test"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type {
  JsonObject,
  LanguageModelRequest,
  LanguageModelStreamEvent,
  ModelUsage,
} from "@sixb/core/models"
import { agentTraceFromModelSteps } from "../../../packages/agent-worker/src/model-adapters"
import { foundryEstimator, foundryUsage } from "../src/accounting"
import { createAzureAIFoundry } from "./provider-fixture"

const endpoint = "https://resource.services.ai.azure.com"
const definition = {
  maxOutputTokens: 100,
  capabilities: {
    localTools: true,
    parallelToolCalls: true,
    nativeStructuredOutput: true,
    reasoning: { canDisable: true, efforts: ["low", "high"] as const },
    inputMediaTypes: ["image/png", "application/pdf"],
  },
}
const schema: JsonObject = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
}
const rateCard = {
  currency: "USD",
  unit: "million-tokens",
  input: "2",
  output: "10",
  cacheReadInput: "1",
} as const

// Captured from live Azure Responses on 2026-09-17. Regression proof: remove the
// explicit-zero cache_write_tokens allowance in accounting.ts; the rated assertion fails.
test("prices Azure's explicit zero cache-write meter without assuming nonzero semantics", () => {
  const raw = {
    input_tokens: 40,
    output_tokens: 8,
    total_tokens: 48,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
  const usage = foundryUsage(raw, true)
  expect(usage).toMatchObject({ uncachedInputTokens: 40, textOutputTokens: 8 })
  expect(foundryEstimator(rateCard, undefined).estimate({ usage })).toMatchObject({
    status: "rated",
  })
  for (const value of [1, null, "0"]) {
    const unknown = foundryUsage(
      { ...raw, input_tokens_details: { cached_tokens: 0, cache_write_tokens: value } },
      true
    )
    expect(foundryEstimator(rateCard, undefined).estimate({ usage: unknown })).toMatchObject({
      status: "unpriceable",
    })
  }
})

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
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")
  )
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    }),
    { headers: { "apim-request-id": "azure-request" } }
  )
}

function completed(
  usage: JsonObject = {
    input_tokens: 10,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 2 },
  }
): Response {
  return sse([
    { type: "response.created", response: { id: "resp", model: "gpt-example-1" } },
    {
      type: "response.completed",
      response: { id: "resp", model: "gpt-example-1", status: "completed", usage },
    },
  ])
}

async function collect(
  events: AsyncIterable<LanguageModelStreamEvent>
): Promise<LanguageModelStreamEvent[]> {
  const result = []
  for await (const event of events) result.push(event)
  return result
}

test.each([
  "",
  "/openai/v1/",
  "/api/projects/example",
  "/api/projects/example/openai/v1/",
])("maps endpoint %s and keeps deployment identity", async (path) => {
  let url: unknown
  let body: JsonObject | undefined
  let headers: Headers | undefined
  const provider = createAzureAIFoundry({
    endpoint: endpoint + path,
    providerId: "foundry-prod",
    apiKey: "key",
    fetch: async (input, init) => {
      url = input
      body = JSON.parse(String(init?.body))
      headers = new Headers(init?.headers)
      return completed()
    },
  })
  const model = provider.responses("deployment", {
    definition,
    metadata: { publisher: "OpenAI", modelName: "gpt-example", modelVersion: "1" },
    maxOutputTokens: 80,
  })
  const events = await collect(
    (await model.stream(request({ maxOutputTokens: 20, reasoning: "high" }))).events
  )
  const project = path.includes("projects")
  expect(url).toBe(`${endpoint}${project ? "/api/projects/example" : ""}/openai/v1/responses`)
  expect(body).toMatchObject({
    model: "deployment",
    stream: true,
    store: false,
    max_output_tokens: 20,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "high" },
  })
  expect(body?.input).toEqual([
    {
      role: "user",
      ...(project ? { type: "message" } : {}),
      content: [{ type: "input_text", text: "Hello" }],
    },
  ])
  expect(headers?.get("api-key")).toBe("key")
  expect(headers?.has("authorization")).toBe(false)
  expect(events).toContainEqual({
    type: "response-metadata",
    id: "resp",
    modelId: "gpt-example-1",
    providerIds: { requestId: "azure-request", responseId: "resp" },
  })
  expect(model.definition.modelId).toBe("deployment")
  expect(model.providerId).toBe("foundry-prod")
  expect(model.metadata.modelName).toBe("gpt-example")
  expect(provider("deployment").protocol).toBe("responses")
})

test("refreshes async credentials on every retry and preserves throttling diagnostics", async () => {
  const auth: (string | null)[] = []
  let tokens = 0
  const provider = createAzureAIFoundry({
    endpoint,
    tokenProvider: async () => `token-${++tokens}`,
    fetch: async (_url, init) => {
      auth.push(new Headers(init?.headers).get("authorization"))
      return auth.length === 1
        ? Response.json(
            { error: { code: "TooManyRequests", message: "slow down" } },
            { status: 429, headers: { "retry-after-ms": "0" } }
          )
        : completed()
    },
  })
  await collect((await provider("deployment").stream(request())).events)
  await collect((await provider("deployment").stream(request())).events)
  expect(auth).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"])
  expect(() =>
    createAzureAIFoundry({ endpoint, apiKey: "key", tokenProvider: () => "token" })
  ).toThrow("either apiKey or tokenProvider")
  const failing = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    maxRetries: 0,
    fetch: async () =>
      Response.json(
        { error: { code: "limited", message: "retry" } },
        { status: 429, headers: { "apim-request-id": "error-id", "retry-after": "2" } }
      ),
  })
  await expect(failing("deployment").stream(request())).rejects.toMatchObject({
    code: "limited",
    requestId: "error-id",
    retryable: true,
    retryAfterMs: 2000,
  })
})

test("cancels pending credentials before fetch and cancels retry waits", async () => {
  const abort = new AbortController()
  let called = false
  const model = createAzureAIFoundry({
    endpoint,
    tokenProvider: (signal) => {
      expect(signal).toBe(abort.signal)
      abort.abort(new Error("cancel credentials"))
      return new Promise<string>(() => {})
    },
    fetch: async () => {
      called = true
      return completed()
    },
  })("deployment")
  await expect(model.stream(request({ signal: abort.signal }))).rejects.toThrow(
    "cancel credentials"
  )
  expect(called).toBe(false)
  const retryAbort = new AbortController()
  const retry = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => {
      retryAbort.abort(new Error("cancel retry"))
      return new Response(null, { status: 503, headers: { "retry-after": "60" } })
    },
  })("deployment")
  await expect(retry.stream(request({ signal: retryAbort.signal }))).rejects.toThrow("cancel retry")
})

test("pins inline definitions, request options and rate cards without catalog I/O", async () => {
  const supplied = {
    ...definition,
    kind: "language" as const,
    providerId: "azure-ai-foundry",
    modelId: "deployment",
  }
  const native = { temperature: 0.2 }
  let body: JsonObject | undefined
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    models: [supplied],
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return completed()
    },
  })
  const model = provider("deployment", { request: native, rateCard })
  supplied.maxOutputTokens = 999
  native.temperature = 1
  expect(await provider.catalog.list()).toHaveLength(1)
  expect(await provider.catalog.get("unknown")).toBeUndefined()
  expect(await model.resolve({ offline: true })).toBe(model)
  expect(await model.resolve()).toBe(model)
  expect(Object.isFrozen(model.definition.capabilities)).toBe(true)
  await collect((await model.stream(request({ maxOutputTokens: 500 }))).events)
  expect(body).toMatchObject({ max_output_tokens: 100, temperature: 0.2 })
})

test("applies Azure strict output and tool policy without weakening schemas", async () => {
  const bodies: JsonObject[] = []
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return completed()
    },
  })("deployment", { definition })
  const tools = [{ name: "answer", description: "Answer", inputSchema: schema }]
  await collect(
    (
      await model.stream(
        request({ tools, responseFormat: { type: "json", name: "answer", schema } })
      )
    ).events
  )
  expect(bodies[0]).toMatchObject({
    parallel_tool_calls: false,
    tools: [{ strict: true, parameters: schema }],
    text: { format: { schema, strict: true } },
  })
  const loose = { type: "object", properties: { answer: { type: "string", minLength: 1 } } }
  await collect(
    (await model.stream(request({ tools: [{ ...tools[0]!, inputSchema: loose }] }))).events
  )
  expect(bodies[1]).toMatchObject({
    tools: [{ strict: false, parameters: loose }],
    parallel_tool_calls: true,
  })
  await expect(
    model.stream(request({ responseFormat: { type: "json", name: "bad", schema: loose } }))
  ).rejects.toThrow("Azure-compatible")
  await expect(model.stream(request({ reasoning: { budgetTokens: 1024 } }))).rejects.toThrow(
    "not supported"
  )
  await expect(model.stream(request({ reasoning: "max" }))).rejects.toThrow("not supported")
  expect(bodies).toHaveLength(2)
})

test("requires explicit capabilities for optional model features", async () => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => {
      throw new Error("must not fetch")
    },
  })("unknown")
  for (const override of [
    { tools: [{ name: "tool", description: "tool", inputSchema: schema }] },
    { reasoning: "high" as const },
    { responseFormat: { type: "json" as const, name: "answer", schema } },
  ]) {
    await expect(model.stream(request(override))).rejects.toMatchObject({
      name: "UnsupportedModelFeatureError",
    })
  }
})

test("sends bounded inline PDFs and images, rejecting mismatches and unsupported sources", async () => {
  let body: JsonObject | undefined
  let calls = 0
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      calls++
      body = JSON.parse(String(init?.body))
      return completed()
    },
  })("deployment", { definition, maxInputFileBytes: 8 })
  const file = (url: string, mediaType = "application/pdf") =>
    request({
      messages: [{ role: "user", content: [{ type: "file", mediaType, data: new URL(url) }] }],
    })
  await collect((await model.stream(file("data:application/pdf;base64,JVBERi0="))).events)
  expect(body?.input).toEqual([
    {
      role: "user",
      content: [
        {
          type: "input_file",
          file_data: "data:application/pdf;base64,JVBERi0=",
          filename: "document.pdf",
        },
      ],
    },
  ])
  await collect((await model.stream(file("https://example.com/image.png", "image/png"))).events)
  await collect((await model.stream(file("data:image/png;base64,aW1hZ2U=", "image/png"))).events)
  for (const url of [
    "https://example.com/file.pdf",
    "file:///report.pdf",
    "data:image/png;base64,JVBERi0=",
    "data:application/pdf;base64,!!!",
    "data:application/pdf;base64,MDEyMzQ1Njc4OQ==",
  ])
    await expect(model.stream(file(url))).rejects.toBeInstanceOf(Error)
  expect(calls).toBe(3)
})

// Regression proof: remove checkScope in request.ts. Reusing opaque history on another
// deployment then sends a second inference request instead of rejecting the mismatched binding.
test("runs tools and replays encrypted reasoning/phase after durable history serialization", async () => {
  const bodies: JsonObject[] = []
  const reasoning = {
    id: "reason",
    type: "reasoning",
    encrypted_content: "opaque",
    summary: [{ type: "summary_text", text: "Réfléchir" }],
  }
  const call = {
    id: "fc",
    type: "function_call",
    call_id: "tool-call",
    name: "check",
    arguments: "{}",
  }
  const provider = createAzureAIFoundry({
    endpoint: `${endpoint}/api/projects/test`,
    apiKey: "key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return sse([
        { type: "response.created", response: { id: "resp" } },
        ...(bodies.length === 1
          ? [
              { type: "response.output_item.done", item: reasoning },
              { type: "response.output_text.done", item_id: "message", text: "Checking." },
              {
                type: "response.output_item.done",
                item: { id: "message", type: "message", phase: "commentary" },
              },
              { type: "response.output_item.added", item: { ...call, arguments: "" } },
              { type: "response.output_item.done", item: call },
            ]
          : [{ type: "response.output_text.done", item_id: "final", text: "Done." }]),
        {
          type: "response.completed",
          response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } },
        },
      ])
    },
  })
  const model = provider("deployment", { definition })
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
  expect(bodies[1]?.input).toEqual([
    { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    reasoning,
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Checking." }],
      phase: "commentary",
    },
    call,
    { type: "function_call_output", call_id: "tool-call", output: "ok" },
  ])
  const history = toModelMessages([
    {
      role: "assistant",
      parts: JSON.parse(JSON.stringify(agentTraceFromModelSteps(result.steps))),
    },
  ])
  await collect((await model.stream(request({ messages: history }))).events)
  expect(bodies[2]?.input).toContainEqual(reasoning)
  await expect(
    provider("other", { definition }).stream(request({ messages: history }))
  ).rejects.toThrow("different endpoint, deployment, or protocol")
  const otherResource = createAzureAIFoundry({
    endpoint: "https://other.openai.azure.com",
    apiKey: "key",
  })("deployment", { definition })
  await expect(otherResource.stream(request({ messages: history }))).rejects.toThrow(
    "different endpoint"
  )
  expect(bodies).toHaveLength(3)
})

test("preserves unknown usage, non-OpenAI reasoning counters, explicit prices and custom estimates", async () => {
  const provider = createAzureAIFoundry({ endpoint, apiKey: "key", fetch: async () => completed() })
  const openai = provider("deployment", {
    metadata: { publisher: "OpenAI", modelName: "gpt-example", modelVersion: "1" },
    rateCard,
  })
  const event = (await collect((await openai.stream(request())).events)).at(-1)
  if (event?.type !== "finish") throw new Error("missing finish")
  expect(event.usage).toMatchObject({
    inputTokens: 10,
    uncachedInputTokens: 8,
    cacheReadInputTokens: 2,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    textOutputTokens: 3,
  })
  expect(
    openai.costEstimator?.estimate({ usage: event.usage, responseModelId: "gpt-example-1" })
  ).toMatchObject({ status: "rated", money: { amountNanos: "68000" } })
  expect(
    openai.costEstimator?.estimate({ usage: event.usage, responseModelId: "different" })
  ).toMatchObject({ status: "unpriceable" })
  const partner = provider("partner", { rateCard })
  const partnerEvent = (await collect((await partner.stream(request())).events)).at(-1)
  if (partnerEvent?.type !== "finish") throw new Error("missing finish")
  expect(partnerEvent.usage.reasoningOutputTokens).toBe(2)
  expect(partnerEvent.usage.textOutputTokens).toBe(3)
  expect(partnerEvent.usage.raw?.output_tokens_details).toEqual({ reasoning_tokens: 2 })
  const extraMeters: JsonObject[] = [
    { input_tokens_details: { cache_write_tokens: 2 } },
    { server_tool_use: { requests: 1 } },
  ]
  for (const raw of extraMeters)
    expect(partner.costEstimator?.estimate({ usage: { ...event.usage, raw } })).toMatchObject({
      status: "unpriceable",
    })
  expect(
    partner.costEstimator?.estimate({ usage: { inputTokens: 10, outputTokens: 5 } })
  ).toMatchObject({ status: "unpriceable", reason: "missing-usage" })
  expect(provider("no-price").costEstimator?.estimate({ usage: event.usage })).toMatchObject({
    status: "unpriceable",
    reason: "missing-rate-card",
  })
  const custom = {
    estimate: (_input: { usage: ModelUsage }) => ({
      status: "rated" as const,
      money: { currency: "USD" as const, amountNanos: "123" },
      components: [],
    }),
  }
  expect(
    provider("custom", { costEstimator: custom }).costEstimator?.estimate({ usage: {} })
  ).toMatchObject({ money: { amountNanos: "123" } })
  const unknown = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => completed({}),
  })("deployment")
  expect((await collect((await unknown.stream(request())).events)).at(-1)).toMatchObject({
    usage: { raw: {} },
  })
})

// Regression proof: remove the root-level error fallback in shared Responses stream.ts.
test("retains Azure's top-level streamed error code and message", async () => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => sse([{ type: "error", code: "content_filter", message: "Filtered" }]),
  })("deployment")
  const events = await collect((await model.stream(request())).events)
  expect(events.at(-1)).toMatchObject({
    type: "error",
    error: {
      code: "content_filter",
      message: "Filtered",
      providerId: "azure-ai-foundry",
      modelId: "deployment",
      requestId: "azure-request",
    },
  })
})

test.each([
  "store",
  "background",
  "previous_response_id",
  "conversation",
  "model",
  "input",
  "reasoning",
  "max_output_tokens",
  "tools",
])("rejects adapter-owned request field %s", (key) => {
  expect(() =>
    createAzureAIFoundry({ endpoint })("deployment", { request: { [key]: true } })
  ).toThrow("owned by the adapter")
})

test.each([
  "https://host/openai/deployments/model",
  "https://host/openai/v1?api-version=preview",
  "https://user:secret@host",
  "file:///resource",
  "https://host/path",
])("rejects ambiguous endpoint %s", (endpoint) => {
  expect(() => createAzureAIFoundry({ endpoint })).toThrow()
})

test("bounds retries, sanitizes non-JSON HTTP errors and never retries accepted streams", async () => {
  let attempts = 0
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    maxRetries: 1,
    fetch: async () => {
      attempts++
      return new Response("private HTML", { status: 503, headers: { "retry-after-ms": "0" } })
    },
  })("deployment")
  await expect(model.stream(request())).rejects.toMatchObject({
    message: "[SixbAzureAIFoundry] Provider request failed with HTTP 503.",
  })
  expect(attempts).toBe(2)
  attempts = 0
  const interrupted = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => {
      attempts++
      return sse([{ type: "response.output_text.delta", delta: "partial" }])
    },
  })("deployment")
  await expect(collect((await interrupted.stream(request())).events)).rejects.toThrow(
    "without a terminal"
  )
  expect(attempts).toBe(1)
})

test("cancels an active SSE body and does not restart generation", async () => {
  let cancelled = false
  let calls = 0
  const abort = new AbortController()
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => {
      calls++
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","delta":"partial"}\n\n'
              )
            )
          },
          cancel() {
            cancelled = true
          },
        })
      )
    },
  })("deployment")
  const consume = async () => {
    for await (const event of (await model.stream(request({ signal: abort.signal }))).events) {
      if (event.type === "text-delta") abort.abort(new Error("stop generation"))
    }
  }
  await expect(consume()).rejects.toThrow("stop generation")
  expect(cancelled).toBe(true)
  expect(calls).toBe(1)
})

test.each([
  "valid",
  "invalid",
  "refused",
  "truncated",
])("preserves billable usage through structured output (%s)", async (mode) => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      sse([
        ...(mode === "refused"
          ? [{ type: "response.refusal.done", item_id: "message", refusal: "No." }]
          : [
              {
                type: "response.output_text.done",
                item_id: "message",
                text: mode === "invalid" ? '{"answer":123}' : '{"answer":"yes"}',
              },
            ]),
        {
          type: mode === "truncated" ? "response.incomplete" : "response.completed",
          response: {
            status: mode === "truncated" ? "incomplete" : "completed",
            ...(mode === "truncated"
              ? { incomplete_details: { reason: "max_output_tokens" } }
              : {}),
            content_filters: [{ category: "test", filtered: mode === "refused" }],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 2 },
            },
          },
        },
      ]),
  })("deployment", { definition, rateCard })
  const usage: ModelUsage[] = []
  const result = runModelLoop({
    model,
    messages: request().messages,
    signal: request().signal,
    maxSteps: 1,
    output: {
      name: "answer",
      schema,
      validate: (value: unknown) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("answer" in value) ||
          value.answer !== "yes"
        )
          throw new TypeError("invalid answer")
        return { answer: "yes" }
      },
    },
    onModelCallEnd: (event) => {
      usage.push(event.usage)
    },
  })
  if (mode === "valid")
    await expect(result).resolves.toMatchObject({ status: "completed", output: { answer: "yes" } })
  else
    await expect(result).rejects.toMatchObject({
      name: "StructuredOutputError",
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { status: "rated" },
    })
  expect(usage).toHaveLength(1)
  expect(usage[0]).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 })
})

test("does not normalize the documented non-OpenAI zero reasoning counter into a text partition", async () => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      completed({
        input_tokens: 10,
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
      }),
  })("deepseek-prod", { metadata: { publisher: "DeepSeek" } })
  const events = await collect((await model.stream(request())).events)
  expect(events.at(-1)).toMatchObject({
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      raw: { output_tokens_details: { reasoning_tokens: 0 } },
    },
  })
  const event = events.at(-1)
  if (event?.type !== "finish") throw new Error("missing finish")
  expect(event.usage.reasoningOutputTokens).toBeUndefined()
  expect(event.usage.textOutputTokens).toBeUndefined()
  expect(event.usage.cacheReadInputTokens).toBeUndefined()
  expect(event.usage.uncachedInputTokens).toBeUndefined()
})
