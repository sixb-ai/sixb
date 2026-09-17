import { expect, test } from "bun:test"
import { runModelLoop } from "@sixb/core/internal/agents"
import {
  type JsonObject,
  type LanguageModelRequest,
  type LanguageModelStreamEvent,
  ModelProviderError,
} from "@sixb/core/models"
import { FoundryTransport } from "../src/transport"
import { createAzureAIFoundry } from "./provider-fixture"

const endpoint = "https://example.test"
const protocols = ["responses", "chat", "messages"] as const
type Protocol = (typeof protocols)[number]
const request = (signal = new AbortController().signal): LanguageModelRequest => ({
  callId: "checklist",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
  maxOutputTokens: 16,
  signal,
})

function response(protocol: Protocol, model: string): Response {
  const input = { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
  const events: (JsonObject | string)[] =
    protocol === "chat"
      ? [
          {
            id: model,
            model,
            choices: [{ index: 0, delta: { content: model }, finish_reason: null }],
          },
          { id: model, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          {
            choices: [],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          },
          "[DONE]",
        ]
      : protocol === "responses"
        ? [
            { type: "response.created", response: { id: model, model } },
            { type: "response.output_text.delta", item_id: "text", delta: model },
            {
              type: "response.completed",
              response: { id: model, model, status: "completed", usage: input },
            },
          ]
        : [
            {
              type: "message_start",
              message: {
                id: model,
                model,
                usage: {
                  input_tokens: 10,
                  output_tokens: 0,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
              },
            },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: model } },
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 5 },
            },
            { type: "message_stop" },
          ]
  return new Response(
    events
      .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
      .join("")
  )
}

async function collect(events: AsyncIterable<LanguageModelStreamEvent>) {
  let text = ""
  let responseModelId: string | undefined
  let finish: Extract<LanguageModelStreamEvent, { type: "finish" }> | undefined
  for await (const event of events) {
    if (event.type === "error") throw event.error
    if (event.type === "text-delta") text += event.delta
    if (event.type === "response-metadata" && event.modelId) responseModelId = event.modelId
    if (event.type === "finish") {
      expect(finish).toBeUndefined()
      finish = event
    }
  }
  if (!finish) throw new Error("Missing finish")
  return { text, finish, responseModelId }
}

// Checklist coverage: simultaneous bindings through the same shared interface must
// not share cancellation, wire configuration, response identity or accounting state.
test.each([
  ...protocols,
])("%s keeps concurrent bindings isolated through completion and cancellation", async (protocol) => {
  const entered = Promise.withResolvers<void>()
  const bodies: Record<string, JsonObject> = {}
  const p = createAzureAIFoundry({
    endpoint,
    apiKey: "test",
    fetch: async (_url, init) => {
      const body: JsonObject = JSON.parse(String(init?.body))
      const name = String(body.model)
      bodies[name] = body
      if (Object.keys(bodies).length === 2) entered.resolve()
      await entered.promise
      return response(protocol, name)
    },
  })
  const card = {
    currency: "USD",
    unit: "million-tokens",
    input: "1",
    output: "2",
    cacheReadInput: "0.1",
    ...(protocol === "messages" ? { cacheWriteInput: "1.5" } : {}),
  } as const
  const alpha = p[protocol]("alpha", { rateCard: card, request: { temperature: 0.1 } })
  const beta = p[protocol]("beta", {
    rateCard: { ...card, input: "3", output: "4" },
    request: { temperature: 0.9 },
  })
  const abort = new AbortController()
  const [a, b] = await Promise.all([alpha.stream(request(abort.signal)), beta.stream(request())])
  abort.abort(new Error("cancel alpha only"))
  await expect(collect(a.events)).rejects.toThrow("cancel alpha only")
  const result = await collect(b.events)
  expect(result.text).toBe("beta")
  expect(result.finish).toMatchObject({
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  expect(result.finish.route?.modelId ?? result.responseModelId).toBe("beta")
  expect(
    beta.costEstimator.estimate({ usage: result.finish.usage, route: result.finish.route })
  ).toMatchObject({ status: "rated", money: { amountNanos: "50000" } })
  expect(alpha.costEstimator.estimate({ usage: result.finish.usage })).toMatchObject({
    status: "rated",
    money: { amountNanos: "20000" },
  })
  expect(bodies.alpha?.temperature).toBe(0.1)
  expect(bodies.beta?.temperature).toBe(0.9)
})

test.each([
  ...protocols,
])("%s rejects unsupported media and aggregate byte overflow before inference", async (protocol) => {
  let calls = 0
  const p = createAzureAIFoundry({
    endpoint,
    apiKey: "test",
    fetch: async () => {
      calls++
      return response(protocol, "model")
    },
  })
  const model = p[protocol]("model", {
    definition: { capabilities: { inputMediaTypes: "any" } },
    maxInputFileBytes: 7,
  })
  for (const mediaType of ["audio/wav", "video/mp4", "application/zip"])
    await expect(
      model.stream({
        ...request(),
        messages: [
          {
            role: "user",
            content: [{ type: "file", mediaType, data: new URL(`data:${mediaType};base64,YQ==`) }],
          },
        ],
      })
    ).rejects.toThrow("not supported")
  await expect(
    model.stream({
      ...request(),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              mediaType: "image/png",
              data: new URL("data:image/png;base64,YWJjZA=="),
            },
            {
              type: "file",
              mediaType: "image/jpeg",
              data: new URL("data:image/jpeg;base64,YWJjZA=="),
            },
          ],
        },
      ],
    })
  ).rejects.toThrow("maxInputFileBytes")
  expect(calls).toBe(0)
})

test.each([
  401, 403, 408, 429, 500, 503,
])("classifies HTTP %i and retains bounded diagnostics", async (status) => {
  let calls = 0
  const transport = new FoundryTransport({
    endpoint,
    apiKey: "test",
    maxRetries: 0,
    fetch: async () => {
      calls++
      return Response.json(
        { error: { code: "service_code", message: "Service diagnostic" } },
        { status, headers: { "request-id": "trace", "retry-after": "2" } }
      )
    },
  })
  await expect(
    transport.post("{}", new AbortController().signal, "provider", "deployment")
  ).rejects.toMatchObject({
    status,
    code: "service_code",
    requestId: "trace",
    retryAfterMs: 2000,
    retryable: status === 408 || status === 429 || status >= 500,
  })
  expect(calls).toBe(1)
})

test("honors Retry-After HTTP dates and retries only eligible HTTP responses", async () => {
  const retryDate = "Thu, 01 Jan 2099 00:00:00 GMT"
  const terminal = new FoundryTransport({
    endpoint,
    apiKey: "test",
    maxRetries: 0,
    fetch: async () => new Response(null, { status: 429, headers: { "retry-after": retryDate } }),
  })
  const started = Date.now()
  try {
    await terminal.post("{}", new AbortController().signal, "provider", "model")
    throw new Error("Expected throttling error")
  } catch (error) {
    if (!(error instanceof ModelProviderError)) throw error
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(Date.parse(retryDate) - Date.now())
    expect(error.retryAfterMs).toBeLessThanOrEqual(Date.parse(retryDate) - started)
  }
  let attempts = 0
  let credentials = 0
  const transport = new FoundryTransport({
    endpoint,
    maxRetries: 1,
    maxRetryDelayMs: 1,
    tokenProvider: () => `credential-${++credentials}`,
    fetch: async (_url, init) => {
      attempts++
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer credential-${attempts}`)
      return attempts === 1
        ? Response.json(
            { error: { message: "busy" } },
            { status: 429, headers: { "retry-after": retryDate } }
          )
        : new Response("ok")
    },
  })
  expect((await transport.post("{}", AbortSignal.timeout(1000), "provider", "model")).ok).toBe(true)
  expect(attempts).toBe(2)
  let networkCalls = 0
  const network = new FoundryTransport({
    endpoint,
    apiKey: "test",
    maxRetries: 3,
    fetch: async () => {
      networkCalls++
      throw new Error("socket closed")
    },
  })
  await expect(
    network.post("{}", new AbortController().signal, "provider", "model")
  ).rejects.toThrow("socket closed")
  expect(networkCalls).toBe(1)
})

// Audit coverage: malformed/truncated arguments must never execute a local tool,
// while their accepted inference usage is still accounted for.
test.each([
  "tool_calls",
  "length",
])("retains billed usage without executing broken %s arguments", async (finish) => {
  let executions = 0
  const model = createAzureAIFoundry({
    endpoint,
    apiKey: "test",
    fetch: async () =>
      new Response(
        `${[
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "t",
                      type: "function",
                      function: { name: "lookup", arguments: '{"broken":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join("")}data: [DONE]\n\n`
      ),
  }).chat("model", {
    definition: { capabilities: { localTools: true } },
    rateCard: { currency: "USD", unit: "million-tokens", input: "1", output: "2" },
  })
  const result = await runModelLoop({
    model,
    messages: request().messages,
    maxSteps: 1,
    maxOutputTokens: 16,
    signal: AbortSignal.timeout(1000),
    tools: [
      {
        name: "lookup",
        description: "Lookup",
        inputSchema: { type: "object" },
        parseInput: (input) => input,
        execute: async () => {
          executions++
          return "unexpected"
        },
        errorText: () => "failed",
      },
    ],
  })
  expect(executions).toBe(0)
  expect(result.steps[0]).toMatchObject({
    usage: { inputTokens: 10, outputTokens: 5 },
    cost: { status: "rated", money: { amountNanos: "20000" } },
  })
  if (finish === "tool_calls")
    expect(JSON.stringify(result.steps[0]?.content)).toContain("Tool input is not valid JSON")
  else expect(result.steps[0]?.content.some((part) => part.type === "tool-call")).toBe(false)
})
