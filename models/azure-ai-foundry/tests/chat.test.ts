import { expect, test } from "bun:test"
import { runModelLoop, toModelMessages } from "@sixb/core/internal/agents"
import type { JsonObject, LanguageModelRequest, LanguageModelStreamEvent } from "@sixb/core/models"
import { agentTraceFromModelSteps } from "../../../packages/agent-worker/src/model-adapters"
import { createAzureAIFoundry as create } from "../src"
import { foundryChatEstimator, foundryChatUsage } from "../src/chat-accounting"
import { createAzureAIFoundry } from "./provider-fixture"

const endpoint = "https://resource.services.ai.azure.com/api/projects/test"
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
    reasoning: { canDisable: true, efforts: ["low", "high"] as const },
    inputMediaTypes: ["image/png", "application/pdf"],
  },
}
const rateCard = {
  currency: "USD",
  unit: "million-tokens",
  input: "2",
  output: "10",
  cacheReadInput: "1",
} as const
const rawUsage = {
  prompt_tokens: 10,
  completion_tokens: 5,
  total_tokens: 15,
  prompt_tokens_details: { cached_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 2 },
}

// Live OpenAI Chat supplies these zero counters even for text-only calls. Regression proof:
// remove Chat's explicit-zero auxiliary meter normalization in chat-accounting.ts.
test("prices live Chat zero audio/prediction meters but preserves unknown charges", () => {
  const raw = {
    ...rawUsage,
    prompt_tokens_details: { cached_tokens: 2, audio_tokens: 0 },
    completion_tokens_details: {
      reasoning_tokens: 2,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  }
  const usage = foundryChatUsage(raw, true)
  expect(usage).toMatchObject({ uncachedInputTokens: 8, textOutputTokens: 3, raw })
  expect(foundryChatEstimator(rateCard, undefined).estimate({ usage })).toMatchObject({
    status: "rated",
  })
  for (const value of [1, null, "0"]) {
    const unknown = foundryChatUsage(
      { ...raw, prompt_tokens_details: { cached_tokens: 2, audio_tokens: value } },
      true
    )
    expect(foundryChatEstimator(rateCard, undefined).estimate({ usage: unknown })).toMatchObject({
      status: "unpriceable",
    })
  }
})
const chunk = (delta: JsonObject = {}, finish: string | null = null): JsonObject => ({
  id: "chat",
  model: "publisher-model",
  choices: [{ index: 0, delta, finish_reason: finish }],
})
function sse(values: readonly (JsonObject | string)[]): Response {
  return new Response(
    values
      .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
      .join(""),
    { headers: { "apim-request-id": "request" } }
  )
}
function completed(
  text = "Done.",
  reason = "stop",
  usage: JsonObject | undefined = rawUsage
): Response {
  return sse([
    chunk({ content: text }),
    chunk({}, reason),
    ...(usage ? [{ choices: [], usage }] : []),
    "[DONE]",
  ])
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
async function collect(
  events: AsyncIterable<LanguageModelStreamEvent>
): Promise<LanguageModelStreamEvent[]> {
  const result: LanguageModelStreamEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

// Captured Azure DeepSeek V3.2 deltas: arguments "", "{}", then '\"\"'.
// Regression proof: remove the shared Chat empty-string terminator guard. No tool
// executes, and continuation replays "null" instead of an object-valued JSON string.
test("completes parameterless tools when Chat appends an empty-string terminator", async () => {
  let calls = 0
  let executions = 0
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      calls++
      if (calls === 1)
        return sse([
          chunk({
            tool_calls: [
              { index: 0, id: "t", type: "function", function: { name: "lookup", arguments: "" } },
            ],
          }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '""' } }] }),
          chunk({}, "tool_calls"),
          { choices: [], usage: rawUsage },
          "[DONE]",
        ])
      const body = JSON.parse(String(init?.body))
      expect(body.messages[1].tool_calls[0].function.arguments).toBe("{}")
      expect(body.messages[2].content).toBe("sixb-739")
      return completed("sixb-739")
    },
  }).chat("deployment", { definition })
  const result = await runModelLoop({
    model,
    messages: request().messages,
    signal: AbortSignal.timeout(1000),
    maxSteps: 2,
    tools: [
      {
        name: "lookup",
        description: "Get the code",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        parseInput: (input) => {
          expect(input).toEqual({})
          return input
        },
        execute: async () => {
          executions++
          return "sixb-739"
        },
        errorText: () => "invalid input",
      },
    ],
  })
  expect(result.status).toBe("completed")
  expect(executions).toBe(1)
  expect(calls).toBe(2)
})

test.each([
  "",
  "/",
])("sends Chat to the canonical resource/project endpoint (%s)", async (suffix) => {
  let captured: JsonObject | undefined
  const provider = createAzureAIFoundry({
    endpoint: endpoint + suffix,
    apiKey: "key",
    fetch: async (url, init) => {
      expect(String(url)).toBe(`${endpoint}/openai/v1/chat/completions`)
      const headers = new Headers(init?.headers)
      expect(headers.get("api-key")).toBe("key")
      expect(headers.has("anthropic-version")).toBe(false)
      captured = JSON.parse(String(init?.body))
      return completed()
    },
  })
  const model = provider.chat("production", { definition, maxOutputTokens: 200 })
  expect(model.protocol).toBe("chat")
  expect(provider("production").protocol).toBe("responses")
  await expect(model.resolve({ offline: true })).rejects.toThrow("not found")
  const events = await collect((await model.stream(request({ maxOutputTokens: 100 }))).events)
  expect(captured).toEqual({
    model: "production",
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 100,
  })
  expect(events.at(-1)).toMatchObject({
    type: "finish",
    usage: { inputTokens: 10, outputTokens: 5 },
    route: { modelId: "publisher-model" },
  })
})

test("refreshes Chat credentials on each retry and surfaces Azure HTTP errors", async () => {
  let tokens = 0
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: async () => `token-${++tokens}`,
    fetch: async (_url, init) => {
      expect(new Headers(init?.headers).get("api-key")).toBe(`token-${tokens}`)
      return tokens === 2
        ? Response.json(
            { error: { code: "rate_limit", message: "busy" } },
            { status: 429, headers: { "retry-after-ms": "0" } }
          )
        : completed()
    },
  }).chat("deployment")
  await collect((await model.stream(request())).events)
  expect(tokens).toBe(3)
  const bad = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      Response.json(
        { error: { code: "content_filter", message: "blocked" } },
        { status: 400, headers: { "apim-request-id": "blocked-request" } }
      ),
  }).chat("deployment")
  await expect(bad.stream(request())).rejects.toMatchObject({
    code: "content_filter",
    status: 400,
    requestId: "blocked-request",
  })
})

test("pins Chat options and supports explicit legacy limits, developer instructions and usage opt-out", async () => {
  let body: JsonObject | undefined
  const options = {
    maxOutputTokens: 100,
    includeUsage: false,
    maxTokensParameter: "max_tokens" as const,
    systemRole: "developer" as const,
    request: { temperature: 0.2 },
  }
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return sse([chunk({ content: "ok" }, "stop"), "[DONE]"])
    },
  }).chat("deployment", options)
  options.maxOutputTokens = 999
  options.includeUsage = true
  options.request.temperature = 0.9
  const events = await collect(
    (
      await model.stream(
        request({ messages: [{ role: "system", content: "Rules" }, ...request().messages] })
      )
    ).events
  )
  expect(body).toMatchObject({
    max_tokens: 100,
    temperature: 0.2,
    messages: [{ role: "developer", content: "Rules" }, { role: "user" }],
  })
  expect(body?.max_completion_tokens).toBeUndefined()
  expect(body?.stream_options).toBeUndefined()
  expect(events.at(-1)).toMatchObject({ type: "finish", usage: {} })
})

test("uses deployment protocol eligibility and keeps resolved models pinned", async () => {
  let calls = 0
  let limit = "100"
  const provider = create({
    catalog: { fetch: async () => Response.json({ azure: { models: {} } }) },
    endpoint,
    apiKey: () => "token",
    discovery: {},
    fetch: async () => {
      calls++
      return Response.json({
        value: [
          {
            type: "ModelDeployment",
            name: "chat-only",
            modelPublisher: "DeepSeek",
            modelName: "DeepSeek-V4-Pro",
            modelVersion: "1",
            capabilities: { responses: "false", chatCompletion: "true", maxOutputToken: limit },
            sku: { name: "GlobalStandard" },
          },
          {
            type: "ModelDeployment",
            name: "responses-only",
            modelPublisher: "OpenAI",
            modelName: "gpt-example",
            modelVersion: "1",
            capabilities: { responses: "true", chatCompletion: "false" },
            sku: { name: "GlobalStandard" },
          },
        ],
      })
    },
  })
  const original = provider.chat("chat-only")
  const [resolved, catalog] = await Promise.all([
    original.resolve(),
    provider.catalog.list({ protocol: "chat" }),
  ])
  expect(calls).toBe(1)
  expect(catalog.map((item) => item.modelId)).toEqual(["chat-only"])
  expect(
    (await provider.catalog.list({ protocol: "responses" })).map((item) => item.modelId)
  ).toEqual(["responses-only"])
  expect(resolved.metadata.modelName).toBe("DeepSeek-V4-Pro")
  expect(resolved.definition.maxOutputTokens).toBeUndefined()
  expect(await provider.catalog.get("chat-only", { protocol: "chat" })).toMatchObject({
    modelId: "chat-only",
  })
  await expect(provider.responses("chat-only").resolve()).rejects.toThrow(
    "Responses is unsupported"
  )
  await expect(provider.chat("responses-only").resolve()).rejects.toThrow("Chat is unsupported")
  limit = "200"
  await provider.catalog.refresh({ protocol: "chat" })
  expect(await resolved.resolve()).toBe(resolved)
  expect(resolved.definition.maxOutputTokens).toBeUndefined()
  expect((await original.resolve({ offline: true })).definition.maxOutputTokens).toBeUndefined()
})

test("requires explicit capabilities and preserves strict schemas without enabling parallel strict tools", async () => {
  const bodies: JsonObject[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return completed()
    },
  })
  const model = provider.chat("deployment", { definition })
  const tools = [{ name: "answer", description: "Answer", inputSchema: schema }]
  await collect(
    (
      await model.stream(
        request({
          tools,
          reasoning: "high",
          responseFormat: { type: "json", name: "answer", schema },
        })
      )
    ).events
  )
  expect(bodies[0]).toMatchObject({
    reasoning_effort: "high",
    parallel_tool_calls: false,
    response_format: { type: "json_schema", json_schema: { name: "answer", schema, strict: true } },
    tools: [{ type: "function", function: { name: "answer", parameters: schema, strict: true } }],
  })
  provider.chat("unknown")
  await provider.catalog.refresh()
  const loose: JsonObject = { type: "object", properties: { x: { type: "number", minimum: 0 } } }
  await collect(
    (await model.stream(request({ tools: [{ ...tools[0]!, inputSchema: loose }] }))).events
  )
  expect(bodies[1]).toMatchObject({
    parallel_tool_calls: true,
    tools: [{ function: { parameters: loose, strict: false } }],
  })
  for (const override of [
    { tools },
    { reasoning: "high" as const },
    { responseFormat: { type: "json" as const, name: "answer", schema } },
  ])
    await expect(provider.chat("unknown").stream(request(override))).rejects.toMatchObject({
      name: "UnsupportedModelFeatureError",
    })
  await expect(model.stream(request({ reasoning: { budgetTokens: 1000 } }))).rejects.toThrow(
    "not supported"
  )
  await expect(
    model.stream(request({ responseFormat: { type: "json", name: "bad", schema: loose } }))
  ).rejects.toThrow("strict-schema")
  expect(bodies).toHaveLength(2)
})

test("uses explicit capabilities rather than model-name heuristics", async () => {
  let body: JsonObject | undefined
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return completed()
    },
  })
  const model = provider.chat("friendly-name", {
    definition,
    identity: { publisher: "OpenAI", modelName: "gpt-5.6-sol" },
  })
  const tools = [{ name: "check", description: "Check", inputSchema: schema }]
  for (const reasoning of [undefined, "provider-default", "high"] as const)
    await collect((await model.stream(request({ tools, reasoning }))).events)
  await collect((await model.stream(request({ tools, reasoning: "none" }))).events)
  expect(body).toMatchObject({ reasoning_effort: "none" })
  // Deployment names are not model identities.
  provider.chat("gpt-5.6-sol", { definition })
  await provider.catalog.refresh()
  await collect(
    (await provider.chat("gpt-5.6-sol", { definition }).stream(request({ tools }))).events
  )
})

test("keeps DeepSeek effort levels explicit and does not equate JSON mode with strict schemas", async () => {
  const bodies: JsonObject[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return completed()
    },
  })
  const model = provider.chat("production", {
    definition,
    profile: "deepseek",
    identity: { publisher: "DeepSeek", modelName: "DeepSeek-V4-Pro" },
  })
  const tools = [{ name: "check", description: "Check", inputSchema: schema }]
  await collect((await model.stream(request({ reasoning: "high", tools }))).events)
  expect(bodies[0]).toMatchObject({
    reasoning_effort: "high",
    tools: [{ function: { name: "check", parameters: schema } }],
  })
  expect(JSON.stringify(bodies[0])).not.toContain('"strict"')
  expect(bodies[0]?.thinking).toBeUndefined()
  await expect(model.stream(request({ reasoning: "max" }))).rejects.toThrow("not supported")
  await expect(
    model.stream(request({ responseFormat: { type: "json", name: "answer", schema } }))
  ).rejects.toThrow("DeepSeek JSON mode")
  provider.chat("r1", {
    definition: { capabilities: { reasoning: {} } },
    identity: { modelName: "DeepSeek-R1-0528" },
  })
  provider.chat("unknown", { definition })
  await provider.catalog.refresh()
  await expect(
    provider
      .chat("r1", {
        definition: { capabilities: { reasoning: {} } },
        identity: { modelName: "DeepSeek-R1-0528" },
      })
      .stream(request({ reasoning: "high" }))
  ).rejects.toThrow("not supported")
  await expect(
    provider.chat("unknown", { definition, reasoningReplay: "tool-continuation" }).stream(request())
  ).rejects.toThrow("DeepSeek Chat profile")
})

test.each([
  "n",
  "messages",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "max_tokens",
  "max_completion_tokens",
  "reasoning_effort",
  "thinking",
  "response_format",
  "stream_options",
  "audio",
  "store",
])("owns Chat request field %s", (key) => {
  expect(() =>
    createAzureAIFoundry({ endpoint, apiKey: "key" }).chat("deployment", {
      request: { [key]: true },
    })
  ).toThrow("owned by the adapter")
})

test("accepts bounded images and rejects Chat PDFs even when media capabilities declare them", async () => {
  let body: JsonObject | undefined
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return completed()
    },
  }).chat("deployment", { definition, maxInputFileBytes: 5 })
  const file = (data: string, mediaType = "image/png") =>
    request({
      messages: [{ role: "user", content: [{ type: "file", data: new URL(data), mediaType }] }],
    })
  await collect((await model.stream(file("data:image/png;base64,aW1hZ2U="))).events)
  expect(body?.messages).toEqual([
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } }],
    },
  ])
  await collect((await model.stream(file("https://example.com/image.png"))).events)
  await expect(model.stream(file("data:image/png;base64,aW1hZ2Vz"))).rejects.toThrow(
    "maxInputFileBytes"
  )
  await expect(
    model.stream(file("data:application/pdf;base64,JVBERi0=", "application/pdf"))
  ).rejects.toThrow("Input media 'application/pdf' is not supported")
})

// Regression proof: bypass validateMessages in foundryChatRequest. Cross-protocol and
// cross-deployment requests then accept scoped Chat reasoning instead of rejecting it.
test("runs local tools and preserves explicitly enabled DeepSeek continuation through durable history", async () => {
  const bodies: JsonObject[] = []
  const provider = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length !== 1) return completed()
      return sse([
        chunk({ reasoning_content: "Thinking" }),
        chunk({
          tool_calls: [
            { index: 0, id: "call", type: "function", function: { name: "ch", arguments: "{" } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { name: "eck", arguments: "}" } }] }),
        chunk({}, "tool_calls"),
        { choices: [], usage: rawUsage },
        "[DONE]",
      ])
    },
  })
  const options = {
    definition,
    profile: "deepseek" as const,
    reasoningReplay: "tool-continuation" as const,
    rateCard,
  }
  const model = provider.chat("deployment", options)
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
        inputSchema: schema,
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
  expect(bodies[1]?.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Hello" }] },
    {
      role: "assistant",
      content: null,
      reasoning_content: "Thinking",
      tool_calls: [{ id: "call", type: "function", function: { name: "check", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "call", content: "ok" },
  ])
  const history = toModelMessages([
    {
      role: "assistant",
      parts: JSON.parse(JSON.stringify(agentTraceFromModelSteps(result.steps))),
    },
  ])
  await collect((await model.stream(request({ messages: history }))).events)
  expect(JSON.stringify(bodies[2]?.messages)).toContain('"reasoning_content":"Thinking"')
  await collect(
    (await model.stream(request({ messages: [...history, ...request().messages] }))).events
  )
  expect(JSON.stringify(bodies[3]?.messages)).not.toContain("reasoning_content")
  await collect(
    (
      await provider
        .chat("deployment", { ...options, reasoningReplay: "omit" })
        .stream(request({ messages: history }))
    ).events
  )
  expect(JSON.stringify(bodies[4]?.messages)).not.toContain("reasoning_content")
  provider.chat("other", options)
  await provider.catalog.refresh()
  await expect(
    provider.chat("other", options).stream(request({ messages: history }))
  ).rejects.toThrow("different endpoint")
  await expect(
    provider.responses("deployment", { definition }).stream(request({ messages: history }))
  ).rejects.toThrow("different endpoint")
  await expect(
    provider.messages("deployment", { definition }).stream(request({ messages: history }))
  ).rejects.toThrow("different endpoint")
  expect(bodies).toHaveLength(5)
})

test("prices final Chat usage without assuming missing counters or double-billing reasoning", () => {
  const usage = foundryChatUsage(rawUsage, true)
  expect(usage).toEqual({
    inputTokens: 10,
    outputTokens: 5,
    cacheReadInputTokens: 2,
    uncachedInputTokens: 8,
    reasoningOutputTokens: 2,
    textOutputTokens: 3,
    raw: rawUsage,
  })
  const estimator = foundryChatEstimator(rateCard, undefined, "publisher-model", "1")
  expect(estimator.estimate({ usage, responseModelId: "publisher-model" })).toMatchObject({
    status: "rated",
    money: { amountNanos: "68000" },
  })
  expect(estimator.estimate({ usage, responseModelId: "other" })).toMatchObject({
    status: "unpriceable",
  })
  const missing = foundryChatUsage({ prompt_tokens: 10, completion_tokens: 5 }, true)
  expect(missing.uncachedInputTokens).toBeUndefined()
  expect(missing.textOutputTokens).toBeUndefined()
  expect(estimator.estimate({ usage: missing })).toMatchObject({
    status: "unpriceable",
    reason: "missing-usage",
  })
  expect(foundryChatUsage(rawUsage, false).reasoningOutputTokens).toBeUndefined()
  const unknown: JsonObject[] = [
    { ...rawUsage, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } },
    { ...rawUsage, input_tokens: 10 },
    { ...rawUsage, completion_tokens_details: { reasoning_tokens: 2, audio_tokens: 1 } },
  ]
  for (const raw of unknown) {
    const normalized = foundryChatUsage(raw, true)
    expect(normalized.raw).toBe(raw)
    expect(normalized.uncachedInputTokens).toBeUndefined()
    expect(estimator.estimate({ usage: normalized })).toMatchObject({ status: "unpriceable" })
  }
})

test.each([
  "valid",
  "invalid",
  "truncated",
  "filtered",
])("preserves Chat usage/cost through structured output (%s)", async (mode) => {
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () =>
      completed(
        mode === "invalid" ? '{"answer":123}' : '{"answer":"yes"}',
        mode === "truncated" ? "length" : mode === "filtered" ? "content_filter" : "stop"
      ),
  }).chat("deployment", {
    definition,
    rateCard,
    identity: { publisher: "OpenAI", modelName: "publisher-model" },
  })
  const resolved = await model.resolve()
  const result = runModelLoop({
    model: resolved,
    messages: request().messages,
    signal: request().signal,
    maxSteps: 1,
    tools: [],
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
        return value
      },
    },
  })
  if (mode === "valid")
    await expect(result).resolves.toMatchObject({ status: "completed", output: { answer: "yes" } })
  else
    await expect(result).rejects.toMatchObject({
      name: "StructuredOutputError",
      usage: { inputTokens: 10, outputTokens: 5 },
      cost: { status: "rated", money: { amountNanos: "68000" } },
    })
})

test("never retries accepted Chat streams and preserves terminal provider errors", async () => {
  let calls = 0
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "key",
    fetch: async () => {
      calls++
      return sse([
        chunk({ content: "partial" }, "stop"),
        { error: { code: "content_filter", message: "blocked" } },
      ])
    },
  }).chat("deployment")
  const events = await collect((await model.stream(request())).events)
  expect(calls).toBe(1)
  expect(events.at(-1)).toMatchObject({
    type: "error",
    error: {
      code: "content_filter",
      providerId: "azure-ai-foundry",
      modelId: "deployment",
      requestId: "request",
    },
  })
  expect(events.some((event) => event.type === "finish")).toBe(false)
})
